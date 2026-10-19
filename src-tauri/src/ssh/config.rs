//! Minimal `~/.ssh/config` resolver: Host/Match blocks, Include, first value wins.
use std::path::{Path, PathBuf};

const MAX_INCLUDE_DEPTH: usize = 8;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ResolvedHost {
    pub host_name: String,
    pub port: u16,
    pub user: Option<String>,
    pub identity_files: Vec<PathBuf>,
}

#[derive(Debug, Default)]
struct Block {
    /// `None` for the global section before the first `Host`.
    patterns: Option<Vec<String>>,
    options: Vec<(String, String)>,
}

#[derive(Debug, Default)]
pub struct SshConfigFile {
    blocks: Vec<Block>,
    home: PathBuf,
}

/// Splits `Key Value`/`Key=Value` and unquotes the arguments.
fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let key_end = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let key = line[..key_end].to_ascii_lowercase();
    let rest = line[key_end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim_start();
    let mut args = Vec::new();
    let (mut cur, mut quoted, mut has) = (String::new(), false, false);
    for c in rest.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            '#' if !quoted && !has && cur.is_empty() => break,
            c if c.is_whitespace() && !quoted => {
                if has || !cur.is_empty() {
                    args.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => cur.push(c),
        }
    }
    if has || !cur.is_empty() {
        args.push(cur);
    }
    Some((key, args))
}

fn glob_match(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') => (0..=t.len()).any(|i| go(&p[1..], &t[i..])),
            Some('?') => !t.is_empty() && go(&p[1..], &t[1..]),
            Some(c) => t.first() == Some(c) && go(&p[1..], &t[1..]),
        }
    }
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    go(&p, &t)
}

fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix('~') {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with('/') => home.join(&rest[1..]),
        _ => PathBuf::from(path),
    }
}

fn local_user() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

/// Expands an `Include` argument into the matching files (sorted).
fn include_paths(arg: &str, home: &Path) -> Vec<PathBuf> {
    let expanded = expand_tilde(arg, home);
    let path = if expanded.is_absolute() { expanded } else { home.join(".ssh").join(expanded) };
    let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
        return Vec::new();
    };
    if !name.contains('*') {
        return vec![path];
    }
    let Some(dir) = path.parent() else { return Vec::new() };
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(|n| glob_match(&name, n)))
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    found.sort();
    found
}

/// Flattens the text and its includes into `(key, args)` directives.
fn directives(
    text: &str,
    home: &Path,
    depth: usize,
    seen: &mut Vec<PathBuf>,
    out: &mut Vec<(String, Vec<String>)>,
) {
    for line in text.lines() {
        let Some((key, args)) = split_line(line) else { continue };
        if key == "include" {
            if depth >= MAX_INCLUDE_DEPTH {
                continue;
            }
            for arg in &args {
                for file in include_paths(arg, home) {
                    let canon = std::fs::canonicalize(&file).unwrap_or_else(|_| file.clone());
                    if seen.contains(&canon) {
                        continue;
                    }
                    seen.push(canon);
                    if let Ok(inner) = std::fs::read_to_string(&file) {
                        directives(&inner, home, depth + 1, seen, out);
                    }
                }
            }
        } else {
            out.push((key, args));
        }
    }
}

impl SshConfigFile {
    pub fn parse(text: &str, home: &Path) -> Self {
        let mut flat = Vec::new();
        directives(text, home, 0, &mut Vec::new(), &mut flat);
        let mut blocks = vec![Block::default()];
        let mut skipping = false;
        for (key, args) in flat {
            match key.as_str() {
                "host" => {
                    skipping = false;
                    blocks.push(Block { patterns: Some(args), options: Vec::new() });
                }
                "match" => skipping = true,
                _ if skipping => {}
                _ => {
                    if let Some(value) = args.into_iter().next() {
                        blocks.last_mut().unwrap().options.push((key, value));
                    }
                }
            }
        }
        Self { blocks, home: home.to_path_buf() }
    }

    pub fn load(path: &Path, home: &Path) -> Self {
        Self::parse(&std::fs::read_to_string(path).unwrap_or_default(), home)
    }

    fn block_applies(block: &Block, alias: &str) -> bool {
        let Some(patterns) = &block.patterns else { return true };
        let mut matched = false;
        for p in patterns {
            if let Some(neg) = p.strip_prefix('!') {
                if glob_match(neg, alias) {
                    return false;
                }
            } else if glob_match(p, alias) {
                matched = true;
            }
        }
        matched
    }

    pub fn resolve(&self, alias: &str) -> ResolvedHost {
        let (mut host_name, mut port, mut user) = (None, None, None);
        let mut identities: Vec<String> = Vec::new();
        for block in self.blocks.iter().filter(|b| Self::block_applies(b, alias)) {
            for (key, value) in &block.options {
                match key.as_str() {
                    "hostname" if host_name.is_none() => {
                        host_name = Some(value.replace("%h", alias))
                    }
                    "port" if port.is_none() => port = value.parse::<u16>().ok(),
                    "user" if user.is_none() => user = Some(value.clone()),
                    "identityfile" => identities.push(value.clone()),
                    _ => {}
                }
            }
        }
        let host_name = host_name.unwrap_or_else(|| alias.to_string());
        let port = port.unwrap_or(22);
        let identity_files = identities
            .iter()
            .map(|raw| {
                let remote = user.clone().unwrap_or_else(local_user);
                expand_tilde(&expand_tokens(raw, &host_name, port, &remote), &self.home)
            })
            .collect();
        ResolvedHost { host_name, port, user, identity_files }
    }

    /// Concrete `Host` aliases (no wildcard, no negation), deduplicated, in file order.
    pub fn aliases(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for p in self.blocks.iter().filter_map(|b| b.patterns.as_ref()).flatten() {
            if !p.contains(['*', '?', '!']) && !out.contains(p) {
                out.push(p.clone());
            }
        }
        out
    }
}

fn expand_tokens(raw: &str, host: &str, port: u16, remote_user: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => out.push_str(host),
            Some('p') => out.push_str(&port.to_string()),
            Some('r') => out.push_str(remote_user),
            Some('u') => out.push_str(&local_user()),
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

/// `~/.ssh/config`; a missing or unreadable file yields an empty config.
pub fn user_config() -> SshConfigFile {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return SshConfigFile::default();
    };
    let home = PathBuf::from(home);
    SshConfigFile::load(&home.join(".ssh").join("config"), &home)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> &'static Path {
        Path::new("/home/u")
    }

    #[test]
    fn resolves_alias_with_globals_and_first_wins() {
        let c = SshConfigFile::parse("User global\nHost prod\n  HostName 10.0.0.5\n  Port 2200\n  User deploy\nHost *\n  User fallback\n  IdentityFile ~/.ssh/id_ed25519\n", home());
        assert_eq!(c.resolve("prod"), ResolvedHost { host_name: "10.0.0.5".into(), port: 2200, user: Some("global".into()), identity_files: vec!["/home/u/.ssh/id_ed25519".into()] });
    }

    #[test]
    fn identity_files_accumulate_and_expand() {
        let c = SshConfigFile::parse("Host web\n  HostName real.example\n  User bob\n  IdentityFile ~/.ssh/%h_%r\n  IdentityFile /keys/%u-%p-100%%\nHost *\n  IdentityFile ~/.ssh/default\n", home());
        let r = c.resolve("web");
        let me = local_user();
        assert_eq!(
            r.identity_files,
            vec![
                PathBuf::from("/home/u/.ssh/real.example_bob"),
                PathBuf::from(format!("/keys/{me}-22-100%")),
                PathBuf::from("/home/u/.ssh/default"),
            ]
        );
    }

    #[test]
    fn wildcard_and_negation() {
        let c = SshConfigFile::parse("Host *.prod !db.prod\n  User ops\n", home());
        assert_eq!(c.resolve("api.prod").user.as_deref(), Some("ops"));
        assert_eq!(c.resolve("db.prod").user, None);
        assert_eq!(c.resolve("api.dev").user, None);
    }

    #[test]
    fn match_blocks_are_ignored() {
        let c = SshConfigFile::parse("Match user x\n User matched\nHost db-1\n User fallback\n", home());
        assert_eq!(c.resolve("db-1").user.as_deref(), Some("fallback"));
        assert_eq!(c.resolve("other").user, None);
    }

    #[test]
    fn equals_syntax_and_quotes() {
        let c = SshConfigFile::parse("Host h\n  Port=2222\n  IdentityFile \"~/k ey\"\n", home());
        let r = c.resolve("h");
        assert_eq!(r.port, 2222);
        assert_eq!(r.identity_files, vec![PathBuf::from("/home/u/k ey")]);
    }

    #[test]
    fn unknown_alias_defaults() {
        let r = SshConfigFile::parse("", Path::new("/h")).resolve("x.example");
        assert_eq!(r.port, 22);
        assert_eq!(r.host_name, "x.example");
    }

    #[test]
    fn hostname_expands_alias_token() {
        let c = SshConfigFile::parse("Host web\n  HostName %h.internal\n", home());
        assert_eq!(c.resolve("web").host_name, "web.internal");
    }

    #[test]
    fn aliases_skip_patterns() {
        let c = SshConfigFile::parse("Host a b *.x !c\nHost a d\n", home());
        assert_eq!(c.aliases(), vec!["a", "b", "d"]);
    }

    #[test]
    fn include_relative_to_ssh_dir() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = dir.path().join(".ssh");
        std::fs::create_dir_all(ssh.join("config.d")).unwrap();
        std::fs::write(ssh.join("config.d").join("work"), "Host w\n  HostName work.example\n  Port 2022\n").unwrap();
        std::fs::write(ssh.join("config"), "Include config.d/*\nHost *\n  User me\n").unwrap();
        let c = SshConfigFile::load(&ssh.join("config"), dir.path());
        let r = c.resolve("w");
        assert_eq!((r.host_name.as_str(), r.port, r.user.as_deref()), ("work.example", 2022, Some("me")));
        assert_eq!(c.aliases(), vec!["w"]);
    }

    #[test]
    fn self_including_config_terminates() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = dir.path().join(".ssh");
        std::fs::create_dir_all(&ssh).unwrap();
        std::fs::write(ssh.join("config"), "Include *\nHost h\n  Port 2200\n").unwrap();
        let c = SshConfigFile::load(&ssh.join("config"), dir.path());
        assert_eq!(c.resolve("h").port, 2200);
    }
}
