//! Safe mode: classifies SQL statements as reads or writes and decides which statements
//! of a batch need a confirmation before anything of the batch is sent.

use serde::Serialize;

use crate::driver::Dialect;
pub use crate::store::SafeMode;
use crate::store::{ConnectionConfig, EnvTag};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StatementClass {
    Read,
    Write,
}

/// The connection's safe mode; `None` ("Default (by environment)") is `ConfirmWrites`
/// on a `prod` connection and `Off` otherwise.
pub fn effective_safe_mode(cfg: &ConnectionConfig) -> SafeMode {
    match cfg.safe_mode {
        Some(mode) => mode,
        None if cfg.env_tag == EnvTag::Prod => SafeMode::ConfirmWrites,
        None => SafeMode::Off,
    }
}

/// The stricter of two modes (`Off` < `ConfirmWrites` < `ConfirmAll`).
pub fn stricter(a: SafeMode, b: SafeMode) -> SafeMode {
    let rank = |m| match m {
        SafeMode::Off => 0,
        SafeMode::ConfirmWrites => 1,
        SafeMode::ConfirmAll => 2,
    };
    if rank(a) >= rank(b) { a } else { b }
}

/// Indices of the statements to confirm before the batch may run (empty: run it).
pub fn needs_confirmation(mode: SafeMode, classes: &[StatementClass]) -> Vec<usize> {
    let confirm = |c: &StatementClass| match mode {
        SafeMode::Off => false,
        SafeMode::ConfirmAll => true,
        SafeMode::ConfirmWrites => *c == StatementClass::Write,
    };
    (0..classes.len())
        .filter(|&i| confirm(&classes[i]))
        .collect()
}

/// Classifies one statement, strictly: it is a `Read` only when it is
/// - a query: first significant word (after comments and opening parentheses) `SELECT`,
///   `WITH`, `VALUES` or `TABLE` (PostgreSQL);
/// - `SHOW …`;
/// - `EXPLAIN` / `DESCRIBE` / `DESC` without `ANALYZE` (it runs the statement) whose
///   explained statement is itself a read query (an allow-list, see [`explain_is_read`]),
///   or in MySQL a bare table name (`DESCRIBE t [col]`);
///
/// and nothing in it (outside strings, quoted identifiers and comments) writes or locks:
/// `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `INTO`, `LOCK`, a `REPLACE` that is not a
/// function call, `FOR UPDATE | SHARE | NO KEY UPDATE | KEY SHARE`. Everything else is a
/// `Write`: other statements, more code after a `;`, empty input, and anything the lexer
/// cannot read (unterminated string, quoted identifier or comment).
///
/// The keyword checks look at every depth, not only the top level (PostgreSQL also
/// locks rows for a `FOR UPDATE` in a subquery). What is unknown here is lexed every
/// way, and the statement is a `Read` only when it is one under all readings:
/// - server settings that change how strings end (MySQL `NO_BACKSLASH_ESCAPES` /
///   `ANSI_QUOTES`, PostgreSQL `standard_conforming_strings`);
/// - MySQL / MariaDB executable comments (`/*! … */`, `/*!50000 … */`, `/*M! … */`):
///   content as code, and as a plain comment ending at the first `*/` (a server below
///   the version, or MySQL for `/*M!`, skips it).
///
/// A `SELECT` calling a function that writes (a user function, `nextval`, …) is still a
/// `Read`: functions are not inspected.
pub fn classify(dialect: Dialect, sql: &str) -> StatementClass {
    let chars: Vec<char> = sql.chars().collect();
    for &lexing in lexings(dialect) {
        match tokens(&chars, lexing) {
            Some(toks) if classify_tokens(dialect, &toks) == StatementClass::Read => {}
            _ => return StatementClass::Write,
        }
    }
    StatementClass::Read
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// An unquoted word (keyword or identifier), uppercased.
    Word(String),
    Open,
    Close,
    Semi,
    /// A string literal or a quoted identifier (never a keyword).
    Quoted,
    /// A number or a parameter (`$1`).
    Literal,
    /// Any other character (operators, `,`, `.`, `=`…).
    Punct(char),
}

/// One reading of the string syntax (see [`classify`]).
#[derive(Debug, Clone, Copy)]
struct Lexing {
    dialect: Dialect,
    /// Backslash escapes in `'…'` (MySQL by default, PostgreSQL with
    /// `standard_conforming_strings = off`).
    single_backslash: bool,
    /// Backslash escapes in `"…"` (MySQL without `ANSI_QUOTES`).
    double_backslash: bool,
    /// MySQL / MariaDB: executable comments are plain comments ending at the first `*/`
    /// (what a server below a `/*!50000` version, or MySQL for MariaDB's `/*M!`, reads);
    /// otherwise their content is code. Unversioned `/*! … */` is always run, but is
    /// read both ways too: a statement whose two readings differ is not worth trusting.
    exec_as_comment: bool,
}

fn lexings(dialect: Dialect) -> &'static [Lexing] {
    const fn l(
        dialect: Dialect,
        single_backslash: bool,
        double_backslash: bool,
        exec_as_comment: bool,
    ) -> Lexing {
        Lexing {
            dialect,
            single_backslash,
            double_backslash,
            exec_as_comment,
        }
    }
    const PG: &[Lexing] = &[
        l(Dialect::Postgres, false, false, false),
        l(Dialect::Postgres, true, false, false),
    ];
    const MYSQL: &[Lexing] = &[
        // Default, NO_BACKSLASH_ESCAPES, ANSI_QUOTES; each with executable comments
        // read as code, then as comments.
        l(Dialect::MySql, true, true, false),
        l(Dialect::MySql, false, false, false),
        l(Dialect::MySql, true, false, false),
        l(Dialect::MySql, true, true, true),
        l(Dialect::MySql, false, false, true),
        l(Dialect::MySql, true, false, true),
    ];
    const SQLITE: &[Lexing] = &[l(Dialect::Sqlite, false, false, false)];
    match dialect {
        Dialect::Postgres => PG,
        Dialect::MySql => MYSQL,
        Dialect::Sqlite => SQLITE,
    }
}

/// Whitespace for the SQL lexers (ASCII only: other characters can be identifier parts).
fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c')
}

fn is_word_start(c: char, dialect: Dialect) -> bool {
    c.is_ascii_alphabetic()
        || c == '_'
        || !c.is_ascii()
        || (c == '$' && dialect != Dialect::Postgres)
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$' || !c.is_ascii()
}

/// Index just past the closing `quote` of a literal or quoted identifier whose content
/// starts at `i` (a doubled quote is an escaped one); `None` when unterminated.
fn skip_quoted(chars: &[char], mut i: usize, quote: char, backslash: bool) -> Option<usize> {
    while i < chars.len() {
        let c = chars[i];
        if backslash && c == '\\' {
            i += 2;
        } else if c == quote {
            if chars.get(i + 1) == Some(&quote) {
                i += 2;
            } else {
                return Some(i + 1);
            }
        } else {
            i += 1;
        }
    }
    None
}

fn starts_with(chars: &[char], i: usize, s: &str) -> bool {
    (i..).zip(s.chars()).all(|(j, c)| chars.get(j) == Some(&c))
}

fn find(chars: &[char], from: usize, s: &[char]) -> Option<usize> {
    (from..=chars.len().checked_sub(s.len())?).find(|&j| chars[j..j + s.len()] == *s)
}

/// The statement's significant tokens (comments dropped), or `None` when it cannot be
/// read to its end.
fn tokens(chars: &[char], lx: Lexing) -> Option<Vec<Tok>> {
    let mysql = lx.dialect == Dialect::MySql;
    let pg = lx.dialect == Dialect::Postgres;
    let n = chars.len();
    let mut out = Vec::new();
    // Inside a MySQL executable comment, whose content is code.
    let mut in_exec = false;
    let mut i = 0;
    while i < n {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if is_space(c) {
            i += 1;
        } else if (c == '-'
            && next == Some('-')
            // MySQL: `--` starts a comment only before a space or control character.
            && (!mysql || chars.get(i + 2).is_none_or(|&c| is_space(c) || c.is_control())))
            || (c == '#' && mysql)
        {
            while i < n && chars[i] != '\n' && chars[i] != '\r' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            let exec = mysql && (starts_with(chars, i, "/*!") || starts_with(chars, i, "/*M!"));
            if exec && !lx.exec_as_comment {
                if in_exec {
                    return None;
                }
                in_exec = true;
                i += if chars[i + 2] == '!' { 3 } else { 4 };
                // The optional minimum server version (`/*!50000 …`).
                while i < n && chars[i].is_ascii_digit() {
                    i += 1;
                }
            } else {
                // PostgreSQL comments nest; MySQL and SQLite ones end at the first `*/`
                // (a nested `/*` inside an executable comment is not looked at here).
                let mut depth = 1;
                i += 2;
                while depth > 0 {
                    if i >= n {
                        return None;
                    }
                    if starts_with(chars, i, "*/") {
                        depth -= 1;
                        i += 2;
                    } else if pg && starts_with(chars, i, "/*") {
                        depth += 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
        } else if c == '*' && next == Some('/') && in_exec {
            in_exec = false;
            i += 2;
        } else if c == '\'' {
            i = skip_quoted(chars, i + 1, '\'', lx.single_backslash)?;
            out.push(Tok::Quoted);
        } else if c == '"' {
            i = skip_quoted(chars, i + 1, '"', mysql && lx.double_backslash)?;
            out.push(Tok::Quoted);
        } else if c == '`' && !pg {
            i = skip_quoted(chars, i + 1, '`', false)?;
            out.push(Tok::Quoted);
        } else if c == '[' && lx.dialect == Dialect::Sqlite {
            i += 1 + chars[i + 1..].iter().position(|&c| c == ']')? + 1;
            out.push(Tok::Quoted);
        } else if c == '$' && pg {
            i += 1;
            if next.is_some_and(|c| c.is_ascii_digit()) {
                // A parameter: `$1`.
                while i < n && chars[i].is_ascii_digit() {
                    i += 1;
                }
                out.push(Tok::Literal);
            } else {
                let mut j = i;
                while j < n && is_word_char(chars[j]) && chars[j] != '$' {
                    j += 1;
                }
                if chars.get(j) == Some(&'$') {
                    // A dollar-quoted string: `$$…$$` or `$tag$…$tag$`.
                    let delim = &chars[i - 1..=j];
                    let end = find(chars, j + 1, delim)?;
                    i = end + delim.len();
                    out.push(Tok::Quoted);
                } else {
                    out.push(Tok::Punct('$'));
                }
            }
        } else if is_word_start(c, lx.dialect) {
            let start = i;
            while i < n && is_word_char(chars[i]) {
                i += 1;
            }
            let word = chars[start..i]
                .iter()
                .collect::<String>()
                .to_ascii_uppercase();
            if pg && word == "E" && chars.get(i) == Some(&'\'') {
                // PostgreSQL escape string: E'…' always takes backslash escapes.
                i = skip_quoted(chars, i + 1, '\'', true)?;
                out.push(Tok::Quoted);
            } else {
                out.push(Tok::Word(word));
            }
        } else if c.is_ascii_digit() {
            while i < n && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            out.push(Tok::Literal);
        } else {
            out.push(match c {
                '(' => Tok::Open,
                ')' => Tok::Close,
                ';' => Tok::Semi,
                c => Tok::Punct(c),
            });
            i += 1;
        }
    }
    (!in_exec).then_some(out)
}

fn is_word(t: &Tok, words: &[&str]) -> bool {
    matches!(t, Tok::Word(w) if words.contains(&w.as_str()))
}

/// True when a token writes or locks anywhere in the statement.
fn writes_or_locks(toks: &[Tok]) -> bool {
    toks.iter().enumerate().any(|(i, t)| {
        let next = toks.get(i + 1);
        is_word(t, &["INSERT", "UPDATE", "DELETE", "MERGE", "INTO", "LOCK"])
            || (is_word(t, &["REPLACE"]) && next != Some(&Tok::Open))
            || (is_word(t, &["FOR"])
                && next.is_some_and(|n| is_word(n, &["UPDATE", "SHARE", "NO", "KEY"])))
    })
}

fn classify_tokens(dialect: Dialect, toks: &[Tok]) -> StatementClass {
    // Code after a `;` is another statement (some drivers run them all in one call).
    let end = toks
        .iter()
        .position(|t| *t == Tok::Semi)
        .unwrap_or(toks.len());
    if toks[end..].iter().any(|t| *t != Tok::Semi) {
        return StatementClass::Write;
    }
    if is_read(dialect, &toks[..end]) {
        StatementClass::Read
    } else {
        StatementClass::Write
    }
}

fn is_read(dialect: Dialect, toks: &[Tok]) -> bool {
    match toks.first() {
        Some(Tok::Word(w)) if w == "SHOW" => !writes_or_locks(toks),
        Some(Tok::Word(w)) if matches!(w.as_str(), "EXPLAIN" | "DESCRIBE" | "DESC") => {
            explain_is_read(dialect, &toks[1..])
        }
        _ => query_is_read(dialect, toks),
    }
}

/// A query that only reads: `SELECT`, `WITH`, `VALUES` or (PostgreSQL) `TABLE`, possibly
/// parenthesized, with nothing in it that writes or locks.
fn query_is_read(dialect: Dialect, toks: &[Tok]) -> bool {
    let Some(Tok::Word(first)) = toks.iter().find(|t| **t != Tok::Open) else {
        return false;
    };
    let read = match first.as_str() {
        "SELECT" | "WITH" | "VALUES" => true,
        "TABLE" => dialect == Dialect::Postgres,
        _ => false,
    };
    read && !writes_or_locks(toks)
}

/// What follows `EXPLAIN` / `DESCRIBE` / `DESC`. A read only without `ANALYZE` (it runs
/// the statement) and when, past the options, what is explained is itself a read query
/// (an allow-list: `EXPLAIN (…) CREATE TABLE … AS`, `EXECUTE …` are writes), or, in
/// MySQL, a bare table name with an optional column (`DESCRIBE t [col]`).
///
/// PostgreSQL takes any identifier as an option name, quoted ones included
/// (`("analyze")`, `U&"…"`): its option list may only hold unquoted words, numbers and
/// commas.
fn explain_is_read(dialect: Dialect, rest: &[Tok]) -> bool {
    if rest.iter().any(|t| is_word(t, &["ANALYZE", "ANALYSE"])) {
        return false;
    }
    let mut rest = rest;
    if dialect == Dialect::Postgres && rest.first() == Some(&Tok::Open) {
        let Some(close) = matching_close(rest) else {
            return false;
        };
        let plain = |t: &Tok| matches!(t, Tok::Word(_) | Tok::Literal | Tok::Punct(','));
        if !rest[1..close].iter().all(plain) {
            return false;
        }
        rest = &rest[close + 1..];
    } else {
        loop {
            rest = match rest {
                [Tok::Word(w), tail @ ..]
                    if matches!(w.as_str(), "VERBOSE" | "EXTENDED" | "PARTITIONS") =>
                {
                    tail
                }
                [Tok::Word(q), Tok::Word(p), tail @ ..] if q == "QUERY" && p == "PLAN" => tail,
                [Tok::Word(f), Tok::Punct('='), Tok::Word(_), tail @ ..] if f == "FORMAT" => tail,
                _ => break,
            };
        }
    }
    query_is_read(dialect, rest) || (dialect == Dialect::MySql && is_bare_name(rest))
}

/// Index of the `)` closing the `(` at `toks[0]`.
fn matching_close(toks: &[Tok]) -> Option<usize> {
    let mut depth = 0usize;
    for (i, t) in toks.iter().enumerate() {
        match t {
            Tok::Open => depth += 1,
            Tok::Close => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Statement keywords never taken for a table name in [`is_bare_name`] (a table named
/// like one has to be quoted there).
const STATEMENT_WORDS: &[&str] = &[
    "SELECT",
    "WITH",
    "VALUES",
    "TABLE",
    "SHOW",
    "EXPLAIN",
    "DESCRIBE",
    "DESC",
    "EXECUTE",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "RENAME",
    "CALL",
    "DO",
    "SET",
    "DECLARE",
    "PREPARE",
    "DEALLOCATE",
    "GRANT",
    "REVOKE",
    "LOAD",
    "HANDLER",
    "OPTIMIZE",
    "REPAIR",
    "CHECK",
    "FLUSH",
    "KILL",
    "RESET",
    "PURGE",
    "INSTALL",
    "UNINSTALL",
    "COPY",
];

/// `name`, `schema.name` (each part an unquoted non-keyword word or a quoted name), then
/// at most one more such part (a column) or a pattern string, and nothing else.
fn is_bare_name(toks: &[Tok]) -> bool {
    let part = |t: Option<&Tok>| match t {
        Some(Tok::Word(w)) => !STATEMENT_WORDS.contains(&w.as_str()),
        Some(Tok::Quoted) => true,
        _ => false,
    };
    if !part(toks.first()) || writes_or_locks(toks) {
        return false;
    }
    let mut i = 1;
    while toks.get(i) == Some(&Tok::Punct('.')) && part(toks.get(i + 1)) {
        i += 2;
    }
    if part(toks.get(i)) {
        i += 1;
    }
    i == toks.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::DriverKind;
    use crate::driver::tls::SslConfig;
    use crate::store::{ConnectionStore, EnvTag, PasswordMode};
    use StatementClass::{Read, Write};

    const ALL: [Dialect; 3] = [Dialect::Postgres, Dialect::MySql, Dialect::Sqlite];

    fn check(dialects: &[Dialect], cases: &[&str], want: StatementClass) {
        for &d in dialects {
            for sql in cases {
                assert_eq!(classify(d, sql), want, "{d:?}: {sql:?}");
            }
        }
    }

    #[test]
    fn reads_are_reads() {
        check(
            &ALL,
            &[
                "select 1",
                "SELECT * FROM t WHERE a = 1 ORDER BY b DESC",
                "  (select a from t)",
                "((select 1))",
                "(select 1) union (select 2)",
                "select 1;",
                "select 1 ;  \n",
                "show tables",
                "SHOW COLUMNS FROM t",
                "explain select * from t",
                "explain select 'analyze'",
                "with a as (select 1) select * from a",
                "with recursive c(x) as (select 1 union all select x + 1 from c where x < 3) \
                 select * from c",
                "values (1)",
                "/* leading */ select 1",
                "-- leading\nselect 1",
                "select 1 -- ; delete from t",
                "select 1 /* ; delete from t */",
                "select ';' as x",
                "select '/* ; delete from t */'",
                "select 'it''s; delete from t'",
                "select \"delete\" from t",
                "select \"a\"\"; delete from t\" from t",
                "select substring('abc' from 1 for 2)",
                "select replace(name, 'a', 'b') from t",
            ],
            Read,
        );
        check(
            &[Dialect::Postgres],
            &[
                "table t",
                "TABLE public.t",
                "select $$; delete from t$$",
                "select $body$ ; delete from t $body$",
                "select $a$ $b$ ; delete $b$ $a$",
                "select e'it\\'s ; delete from t'",
                "select E'\\\\'",
                "select a$b$ from t",
                "select $1",
                "explain (format json) select 1",
                "explain (verbose, costs 0, format json) select * from t",
                "explain verbose select 1",
                "select 1 # 2",
                "select 1 --x; delete from t",
                "select 1 /* a /* b */ ; delete from t */",
            ],
            Read,
        );
        check(
            &[Dialect::MySql],
            &[
                "describe t",
                "desc t",
                "DESCRIBE db.t",
                "describe `t` `col`",
                "describe t 'a%'",
                "explain t",
                "explain format=json select 1",
                "explain extended select 1",
                "select 1 /*!50000 , 2 */",
                "select `delete` from t",
                "select `a``; delete from t` from t",
                "select 1 # ; delete from t",
                "select 1 --1",
                "select 1 -- ; delete from t",
                "select 'a\\\\' from t",
                "select \"a ; delete\" from t",
                "select 1 /*+ BKA(t) */",
            ],
            Read,
        );
        check(
            &[Dialect::Sqlite],
            &[
                "explain query plan select * from t",
                "explain select 1",
                "select [delete] from t",
                "select [a;delete from t] from t",
                "select `a; delete` from t",
                "select 'C:\\' from t",
            ],
            Read,
        );
    }

    #[test]
    fn writes_are_writes() {
        check(
            &ALL,
            &[
                "insert into t values (1)",
                "update t set a = 1",
                "delete from t",
                "merge into t using s on t.id = s.id when matched then delete",
                "create table x(a int)",
                "drop table t",
                "alter table t add b int",
                "truncate t",
                "grant select on t to u",
                "revoke select on t from u",
                "set search_path = x",
                "use db",
                "call p()",
                "do $$begin end$$",
                "copy t to stdout",
                "vacuum",
                "analyze t",
                "begin",
                "start transaction",
                "commit",
                "rollback",
                "replace into t values (1)",
                "pragma journal_mode = wal",
                "lock table t",
                "refresh materialized view v",
                "prepare p as select 1",
                "execute p",
                "listen x",
                "handler t open",
                "load data infile 'x' into table t",
                "reindex t",
                "comment on table t is 'x'",
                "  (delete from t)",
                "  update t set a = 1",
            ],
            Write,
        );
        // TABLE is a PostgreSQL read only.
        check(&[Dialect::MySql, Dialect::Sqlite], &["table t"], Write);
    }

    /// The Review Focus disguises (and a few more) in confirmWrites mode.
    #[test]
    fn disguised_writes_need_confirmation() {
        let disguised: &[(&[Dialect], &str)] = &[
            (
                &ALL,
                "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
            ),
            (
                &ALL,
                "with u as (update t set a = 1 returning *) select * from u",
            ),
            (
                &ALL,
                "with i as (insert into t values (1) returning *) select 1",
            ),
            (
                &ALL,
                "with m as (merge into t using s on true when matched then delete) select 1",
            ),
            (&ALL, "with x as (select 1) delete from t"),
            (&ALL, "with x as (select 1) insert into t select * from x"),
            (&ALL, "with x as (select 1) update t set a = 1"),
            (&ALL, "with x as (select * into y from t) select 1"),
            (
                &[Dialect::Sqlite],
                "with x as (select 1) replace into t select * from x",
            ),
            (&ALL, "EXPLAIN ANALYZE DELETE FROM t"),
            (&ALL, "explain analyze select 1"),
            (&ALL, "explain analyse select 1"),
            (&ALL, "EXPLAIN (ANALYZE) DELETE FROM t"),
            (&ALL, "explain (format json, analyze true) delete from t"),
            (&ALL, "explain (analyze, buffers) update t set a = 1"),
            (&[Dialect::MySql], "describe analyze select 1"),
            (&[Dialect::MySql], "desc analyze select 1"),
            // PostgreSQL takes any identifier as an EXPLAIN option name, quoted ones too,
            // and EXPLAIN ANALYZE runs the statement.
            (
                &ALL,
                "EXPLAIN (\"analyze\") CREATE TABLE stolen AS SELECT * FROM users",
            ),
            (
                &ALL,
                "EXPLAIN (\"analyze\") CREATE MATERIALIZED VIEW mv AS SELECT 1",
            ),
            (&ALL, "EXPLAIN (\"analyze\") EXECUTE p"),
            (&ALL, "EXPLAIN (\"analyze\") SELECT 1"),
            (&ALL, "explain (verbose, \"analyze\" true) select 1"),
            (
                &ALL,
                "EXPLAIN (U&\"analyze\") CREATE TABLE stolen AS SELECT * FROM users",
            ),
            (&ALL, "EXPLAIN (U&\"\\0061nalyze\") EXECUTE p"),
            (&ALL, "explain (format 'json', \"analyze\") execute p"),
            (&ALL, "explain (\"ANALYZE\") select 1"),
            // Allow-list of explained statements: only read queries.
            (&ALL, "explain create table x as select 1"),
            (
                &ALL,
                "explain (verbose) create materialized view mv as select 1",
            ),
            (&ALL, "explain execute p"),
            (&ALL, "explain verbose execute p"),
            (&ALL, "explain declare c cursor for select 1"),
            (&ALL, "explain show tables"),
            (&ALL, "explain"),
            (&ALL, "explain ()"),
            (&ALL, "explain (verbose select 1"),
            (&[Dialect::Postgres, Dialect::Sqlite], "explain t"),
            (&[Dialect::Postgres, Dialect::Sqlite], "describe t"),
            (&[Dialect::MySql], "explain t; delete from t"),
            (&[Dialect::MySql], "describe t col extra"),
            (&[Dialect::MySql], "explain format=json delete from t"),
            (&[Dialect::Sqlite], "explain query plan delete from t"),
            (
                &[Dialect::Sqlite],
                "explain query plan insert into t values (1)",
            ),
            (&ALL, "SELECT * INTO new_table FROM t"),
            (&ALL, "select a into @x from t"),
            (&[Dialect::MySql], "select * from t into outfile '/tmp/x'"),
            (&ALL, "(select * into new_table from t)"),
            (&ALL, "SELECT * FROM t FOR UPDATE"),
            (&ALL, "select * from t for update nowait"),
            (&ALL, "select * from t for no key update"),
            (&ALL, "select * from t for share"),
            (&ALL, "select * from t for key share"),
            (&ALL, "select * from (select * from t for update) s"),
            (&[Dialect::MySql], "select * from t lock in share mode"),
            (&ALL, "select * from t for /* c */ update"),
            (&ALL, "select * from t\nfor\nshare"),
            (&ALL, "/* select */ delete from t"),
            (&[Dialect::MySql], "/*!*/delete from t"),
            (&[Dialect::MySql], "/*!select 1*/ /*!; delete from t*/"),
            (&ALL, "/* select 1; */ update t set a = 1"),
            (&ALL, "-- select\nupdate t set a = 1"),
            (&ALL, "-- select\r\nupdate t set a = 1"),
            (&[Dialect::MySql], "# select\nupdate t set a = 1"),
            (&[Dialect::MySql], "/*!50000 DELETE FROM t */"),
            (&[Dialect::MySql], "/*!DELETE FROM t*/"),
            (&[Dialect::MySql], "/*!50000 select 1; */ delete from t"),
            (&[Dialect::MySql], "/*M!100100 delete from t */"),
            (
                &[Dialect::MySql],
                "select 1 /*!50000 into outfile '/tmp/x' */",
            ),
            (
                &[Dialect::MySql],
                "select 1 /*!50000 , (select 1 for update) */",
            ),
            // A server below the version (or MySQL, for /*M!) reads an executable comment
            // as a plain comment ending at the first `*/`.
            (
                &[Dialect::MySql],
                "select 1 /*!99999 ' */ ; delete from t -- ' */",
            ),
            (
                &[Dialect::MySql],
                "select 1 /*M! ' */ ; delete from t -- ' */",
            ),
            (
                &[Dialect::MySql],
                "select 1 /*M!100100 ' */ ; delete from t -- ' */",
            ),
            (
                &[Dialect::MySql],
                "select 1 /*!80000 ' */ into outfile '/tmp/x' -- ' */",
            ),
            (
                &[Dialect::MySql],
                "select 1 /*!99999 \" */ for update -- \" */",
            ),
            (
                &[Dialect::MySql],
                "select 1 /*!99999 ` */ ; delete from t -- ` */",
            ),
            (
                &[Dialect::MySql],
                "select 1 /*! ' */ ; delete from t -- ' */",
            ),
            // A statement hidden after a `;` (one driver call may run several).
            (&ALL, "select 1; delete from t"),
            (&ALL, "select ';' ; delete from t"),
            (&ALL, "select 1;\n-- c\ndelete from t"),
            (&[Dialect::Postgres], "select $$x$$; delete from t"),
            (&[Dialect::Postgres], "select 1into t"),
            // Not a comment in MySQL: `--` needs a following space.
            (&[Dialect::MySql], "select 1 --x; delete from t"),
            // MySQL comments do not nest: the delete is code.
            (
                &[Dialect::MySql],
                "select 1 /* a /* b */ ; delete from t */",
            ),
            (
                &[Dialect::Sqlite],
                "select 1 /* a /* b */ ; delete from t */",
            ),
            // Read with backslash escapes on, multi-statement with them off
            // (NO_BACKSLASH_ESCAPES / standard_conforming_strings): either way, confirm.
            (&[Dialect::MySql], "select 'a\\'; delete from t; -- '"),
            (&[Dialect::MySql], "select \"a\\\"; delete from t; -- \""),
            (&[Dialect::Postgres], "select 'a\\'; delete from t; -- '"),
            // Executable comments are MySQL only; elsewhere they hide nothing.
            (
                &[Dialect::Postgres, Dialect::Sqlite],
                "/*!50000 delete from t */ update t set a = 1",
            ),
        ];
        for (dialects, sql) in disguised {
            for &d in *dialects {
                let class = classify(d, sql);
                assert_eq!(class, Write, "{d:?}: {sql:?}");
                assert_eq!(
                    needs_confirmation(SafeMode::ConfirmWrites, &[class]),
                    [0],
                    "{d:?}: {sql:?}"
                );
            }
        }
    }

    #[test]
    fn empty_or_unparseable_is_write() {
        check(
            &ALL,
            &[
                "",
                "   \n\t",
                ";",
                ";;",
                "-- only a comment",
                "/* only a comment */",
                "select 'unterminated",
                "select \"unterminated",
                "select 1 /* unterminated",
                "(",
                "42",
                "'a string'",
                "\"select\"",
                "selectx 1",
                // Servers only know ASCII keywords: these are identifiers, not SELECT.
                "\u{17f}elect 1",
                "\u{455}elect 1",
                "?",
            ],
            Write,
        );
        check(
            &[Dialect::Postgres],
            &[
                "select $$ unterminated",
                "select $a$ x $b$",
                "select e'unterminated\\'",
                "select 1 /* a /* b */ still in a comment",
            ],
            Write,
        );
        check(
            &[Dialect::MySql],
            &["select `x", "/*!50000 select 1", "select 'a\\'"],
            Write,
        );
        check(&[Dialect::Sqlite], &["select [x"], Write);
        // Just a comment outside MySQL; in MySQL also read as a comment (a server below
        // the version runs nothing), so not a recognised read either.
        check(&ALL, &["/*!50000 select 1 */", "/*!select 1*/"], Write);
    }

    #[test]
    fn needs_confirmation_by_mode() {
        let classes = [Read, Write, Read, Write];
        assert!(needs_confirmation(SafeMode::Off, &classes).is_empty());
        assert_eq!(
            needs_confirmation(SafeMode::ConfirmWrites, &classes),
            [1, 3]
        );
        assert_eq!(
            needs_confirmation(SafeMode::ConfirmAll, &classes),
            [0, 1, 2, 3]
        );
        assert!(needs_confirmation(SafeMode::ConfirmWrites, &[Read, Read]).is_empty());
        assert_eq!(needs_confirmation(SafeMode::ConfirmAll, &[Read]), [0]);
        assert!(needs_confirmation(SafeMode::ConfirmAll, &[]).is_empty());
    }

    fn cfg(env_tag: EnvTag, safe_mode: Option<SafeMode>) -> ConnectionConfig {
        ConnectionConfig {
            id: "c".into(),
            name: "n".into(),
            color: "swatch-1".into(),
            env_tag,
            kind: DriverKind::Postgres,
            host: "db.example.com".into(),
            port: 5432,
            user: "u".into(),
            database: None,
            sqlite_path: None,
            password_mode: PasswordMode::Ask,
            group: None,
            ssl: SslConfig::default(),
            ssh: None,
            safe_mode,
        }
    }

    #[test]
    fn effective_safe_mode_defaults_by_environment() {
        assert_eq!(
            effective_safe_mode(&cfg(EnvTag::Prod, None)),
            SafeMode::ConfirmWrites
        );
        for tag in [EnvTag::Local, EnvTag::Dev, EnvTag::Staging] {
            assert_eq!(
                effective_safe_mode(&cfg(tag, None)),
                SafeMode::Off,
                "{tag:?}"
            );
        }
        for mode in [SafeMode::Off, SafeMode::ConfirmAll, SafeMode::ConfirmWrites] {
            assert_eq!(effective_safe_mode(&cfg(EnvTag::Prod, Some(mode))), mode);
            assert_eq!(effective_safe_mode(&cfg(EnvTag::Local, Some(mode))), mode);
        }
    }

    /// A config saved before safe mode existed (no `safeMode` key), tagged prod, read
    /// back through the store: the default `confirmWrites` applies.
    #[test]
    fn legacy_prod_connection_defaults_to_confirm_writes() {
        let json = r#"{"id":"legacy","name":"prod db","color":"swatch-1","envTag":"prod",
            "kind":"postgres","host":"db.example.com","port":5432,"user":"app",
            "database":"app","sqlitePath":null,"passwordMode":"keyring","group":null}"#;
        let parsed: ConnectionConfig = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.safe_mode, None);
        assert_eq!(effective_safe_mode(&parsed), SafeMode::ConfirmWrites);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        let store = ConnectionStore::open(&path).unwrap();
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute(
                "INSERT INTO connections(id, name, config_json) VALUES('legacy', 'prod db', ?1)",
                [json],
            )
            .unwrap();
        let stored = store.get("legacy").unwrap();
        assert_eq!(stored.safe_mode, None);
        assert_eq!(effective_safe_mode(&stored), SafeMode::ConfirmWrites);
    }

    #[test]
    fn serde_names() {
        let modes = [SafeMode::Off, SafeMode::ConfirmAll, SafeMode::ConfirmWrites];
        assert_eq!(
            serde_json::to_string(&modes).unwrap(),
            r#"["off","confirmAll","confirmWrites"]"#
        );
        let back: Vec<SafeMode> =
            serde_json::from_str(r#"["off","confirmAll","confirmWrites"]"#).unwrap();
        assert_eq!(back, modes);
        assert_eq!(
            serde_json::to_string(&[Read, Write]).unwrap(),
            r#"["read","write"]"#
        );
        let c = serde_json::to_value(cfg(EnvTag::Prod, Some(SafeMode::ConfirmAll))).unwrap();
        assert_eq!(c["safeMode"], "confirmAll");
        let c = serde_json::to_value(cfg(EnvTag::Prod, None)).unwrap();
        assert!(c["safeMode"].is_null());
        let e = crate::error::AppError::new(crate::error::ErrorKind::ConfirmationRequired, "0,2");
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"kind":"confirmationRequired","message":"0,2"}"#
        );
    }
}
