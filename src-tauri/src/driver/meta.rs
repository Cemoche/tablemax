//! Table metadata shared by every driver (`Session::table_info`): columns, keys, indexes,
//! foreign keys, and the row key that decides whether the grid may edit the table.

use serde::{Deserialize, Serialize};

use super::{ObjectKind, ObjectRef};
use crate::error::{AppError, ErrorKind};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// PostgreSQL: `format_type`; MySQL/MariaDB: `COLUMN_TYPE`; SQLite: the declared type.
    pub type_name: String,
    pub nullable: bool,
    /// The default as an SQL expression (string literals quoted, e.g. `'abc'`, `0`,
    /// `CURRENT_TIMESTAMP`); `None` without a default or with `DEFAULT NULL`.
    pub default: Option<String>,
    /// serial / identity / AUTO_INCREMENT / SQLite `INTEGER PRIMARY KEY` (rowid alias).
    pub auto_increment: bool,
    /// Generated (computed) column: never editable.
    pub generated: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    /// Key columns in index order; an expression part is shown as its expression
    /// (PostgreSQL, MySQL) or `(expression)` (SQLite).
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    /// `CREATE INDEX ...` when the engine has one (PostgreSQL, SQLite named indexes).
    pub definition: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    /// `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL` or `SET DEFAULT`, as the server reports.
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub object: ObjectRef,
    pub kind: ObjectKind,
    pub columns: Vec<ColumnInfo>,
    pub primary_key: Vec<String>,
    /// Primary index first, then by name.
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    /// Columns identifying one row: the primary key, else the first (by name) unique
    /// index whose columns are all NOT NULL, else `None`.
    pub row_key: Option<Vec<String>>,
    /// SQLite: a table with a rowid (not `WITHOUT ROWID`, not a view). Always false elsewhere.
    pub has_rowid: bool,
}

impl TableInfo {
    /// The grid may edit rows: a table with a row key.
    pub fn editable(&self) -> bool {
        self.kind == ObjectKind::Table && self.row_key.is_some()
    }

    pub fn column(&self, name: &str) -> Option<&ColumnInfo> {
        self.columns.iter().find(|c| c.name == name)
    }
}

/// The row key (see [`TableInfo::row_key`]). `candidates` are the unique indexes that may
/// serve as a key: drivers leave out partial indexes, which are only unique on a subset.
/// An expression part never matches a column, so such an index is skipped.
pub fn derive_row_key<'a>(
    primary_key: &[String],
    candidates: impl IntoIterator<Item = &'a IndexInfo>,
    columns: &[ColumnInfo],
) -> Option<Vec<String>> {
    if !primary_key.is_empty() {
        return Some(primary_key.to_vec());
    }
    let not_null = |name: &String| columns.iter().any(|c| &c.name == name && !c.nullable);
    let mut usable: Vec<&IndexInfo> = candidates
        .into_iter()
        .filter(|i| i.unique && !i.columns.is_empty() && i.columns.iter().all(not_null))
        .collect();
    usable.sort_by(|a, b| a.name.cmp(&b.name));
    usable.first().map(|i| i.columns.clone())
}

/// `NotFound` for a table or view that does not exist in `schema`.
pub fn object_not_found(schema: &str, name: &str) -> AppError {
    AppError::new(ErrorKind::NotFound, format!("{schema}.{name} not found"))
}

/// `None` for a missing default and for a NULL one (`NULL`, PostgreSQL `NULL::type`).
pub fn non_null_default(default: Option<String>) -> Option<String> {
    default.filter(|d| {
        let d = d.trim().to_ascii_lowercase();
        d != "null" && !d.starts_with("null::")
    })
}

/// Primary index first, then by name.
pub fn sort_indexes(indexes: &mut [IndexInfo]) {
    indexes.sort_by(|a, b| b.primary.cmp(&a.primary).then_with(|| a.name.cmp(&b.name)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str, nullable: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            type_name: "int".into(),
            nullable,
            default: None,
            auto_increment: false,
            generated: false,
            comment: None,
        }
    }

    fn index(name: &str, columns: &[&str], unique: bool) -> IndexInfo {
        IndexInfo {
            name: name.into(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            unique,
            primary: false,
            definition: None,
        }
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn row_key_prefers_primary_then_first_not_null_unique_by_name() {
        let cols = [column("a", false), column("b", true), column("c", false)];
        let idx = [
            index("z_c", &["c"], true),
            index("a_b", &["b"], true),      // nullable column
            index("m_plain", &["a"], false), // not unique
            index("n_expr", &["lower(a)"], true),
            index("y_ac", &["a", "c"], true),
        ];
        assert_eq!(
            derive_row_key(&strings(&["b"]), &idx, &cols),
            Some(strings(&["b"]))
        );
        assert_eq!(derive_row_key(&[], &idx, &cols), Some(strings(&["a", "c"])));
        assert_eq!(derive_row_key(&[], &idx[..4], &cols), Some(strings(&["c"])));
        assert_eq!(derive_row_key(&[], &idx[1..4], &cols), None);
        assert_eq!(derive_row_key(&[], [], &cols), None);
    }

    #[test]
    fn editable_needs_a_table_with_a_row_key() {
        let mut info = TableInfo {
            object: ObjectRef {
                schema: None,
                name: "t".into(),
            },
            kind: ObjectKind::Table,
            columns: vec![column("a", false)],
            primary_key: vec![],
            indexes: vec![],
            foreign_keys: vec![],
            row_key: Some(strings(&["a"])),
            has_rowid: false,
        };
        assert!(info.editable());
        assert_eq!(info.column("a").map(|c| c.name.as_str()), Some("a"));
        assert!(info.column("zz").is_none());
        info.kind = ObjectKind::View;
        assert!(!info.editable());
        info.kind = ObjectKind::Table;
        info.row_key = None;
        assert!(!info.editable());
    }

    #[test]
    fn serializes_camel_case() {
        let c = ColumnInfo {
            auto_increment: true,
            ..column("id", false)
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["typeName"], "int");
        assert_eq!(v["autoIncrement"], true);
        let fk = ForeignKeyInfo {
            name: "f".into(),
            columns: strings(&["a"]),
            ref_schema: None,
            ref_table: "p".into(),
            ref_columns: strings(&["id"]),
            on_update: "NO ACTION".into(),
            on_delete: "CASCADE".into(),
        };
        let v = serde_json::to_value(&fk).unwrap();
        assert_eq!(v["refTable"], "p");
        assert_eq!(v["onDelete"], "CASCADE");
    }

    #[test]
    fn null_defaults_are_none() {
        for d in ["NULL", "null", " NULL::character varying"] {
            assert_eq!(non_null_default(Some(d.into())), None, "{d}");
        }
        assert_eq!(non_null_default(None), None);
        assert_eq!(
            non_null_default(Some("'NULL'".into())),
            Some("'NULL'".into())
        );
        assert_eq!(non_null_default(Some("0".into())), Some("0".into()));
    }

    #[test]
    fn primary_index_sorts_first() {
        let mut v = vec![index("b", &["x"], true), index("a", &["y"], false), {
            let mut p = index("z_pkey", &["id"], true);
            p.primary = true;
            p
        }];
        sort_indexes(&mut v);
        let names: Vec<_> = v.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["z_pkey", "a", "b"]);
    }
}
