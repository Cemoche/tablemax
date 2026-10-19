//! Completion catalog: the tables, views and columns of one schema (one query per
//! engine), the routine list, plus the per-workspace cache the manager keeps of them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use super::ObjectKind;

/// How long a fetched catalog is served from the cache (`refresh` bypasses it).
pub const CATALOG_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogColumn {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTable {
    pub name: String,
    pub kind: ObjectKind,
    /// In definition order.
    pub columns: Vec<CatalogColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema: Option<String>,
    /// Sorted by name, like `list_objects`.
    pub tables: Vec<CatalogTable>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RoutineKind {
    Function,
    Procedure,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbRoutine {
    pub schema: Option<String>,
    pub name: String,
    pub kind: RoutineKind,
}

/// Groups `(table, kind, column)` rows, ordered by table then column position, into a
/// catalog. A table without columns arrives as one row with no column.
pub(crate) fn group_rows(
    schema: Option<String>,
    rows: impl IntoIterator<Item = (String, ObjectKind, Option<CatalogColumn>)>,
) -> Catalog {
    let mut tables: Vec<CatalogTable> = Vec::new();
    for (name, kind, col) in rows {
        if tables.last().is_none_or(|t| t.name != name) {
            tables.push(CatalogTable {
                name,
                kind,
                columns: Vec::new(),
            });
        }
        if let Some(c) = col {
            tables.last_mut().expect("just pushed").columns.push(c);
        }
    }
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    Catalog { schema, tables }
}

type Key = (String, Option<String>);

#[derive(Default)]
struct CacheState {
    entries: HashMap<Key, (Instant, Arc<Catalog>)>,
    /// Bumped when a workspace's catalogs become invalid; a fetch that started before
    /// the bump is not stored.
    generations: HashMap<String, u64>,
}

/// Catalogs per `(workspace, schema)`. Short std lock, never held across `.await`.
pub struct CatalogCache {
    ttl: Duration,
    state: Mutex<CacheState>,
}

impl CatalogCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            state: Mutex::default(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, CacheState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The fresh cached catalog, if any.
    pub fn get(&self, workspace: &str, schema: Option<&str>) -> Option<Arc<Catalog>> {
        let st = self.lock();
        let (at, cat) = st
            .entries
            .get(&(workspace.to_string(), schema.map(String::from)))?;
        (at.elapsed() < self.ttl).then(|| cat.clone())
    }

    /// Generation to hand back to [`Self::put`]; take it before fetching.
    pub fn generation(&self, workspace: &str) -> u64 {
        self.lock().generations.get(workspace).copied().unwrap_or(0)
    }

    /// Stores `catalog` unless the workspace was invalidated since `generation` or
    /// `alive` says it is gone (evaluated under the cache lock).
    pub fn put(
        &self,
        workspace: &str,
        schema: Option<&str>,
        generation: u64,
        catalog: Arc<Catalog>,
        alive: impl FnOnce() -> bool,
    ) {
        let mut st = self.lock();
        if st.generations.get(workspace).copied().unwrap_or(0) != generation || !alive() {
            return;
        }
        st.entries.insert(
            (workspace.to_string(), schema.map(String::from)),
            (Instant::now(), catalog),
        );
    }

    /// Drops the workspace's entries (database switch).
    pub fn invalidate(&self, workspace: &str) {
        let mut st = self.lock();
        st.entries.retain(|(w, _), _| w != workspace);
        *st.generations.entry(workspace.to_string()).or_insert(0) += 1;
    }

    /// Forgets the workspace entirely (it closed).
    pub fn forget(&self, workspace: &str) {
        let mut st = self.lock();
        st.entries.retain(|(w, _), _| w != workspace);
        st.generations.remove(workspace);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(n: &str) -> Option<CatalogColumn> {
        Some(CatalogColumn {
            name: n.into(),
            type_name: "int".into(),
        })
    }

    #[test]
    fn group_rows_keeps_column_order_and_empty_tables() {
        let c = group_rows(
            Some("s".into()),
            [
                ("b".to_string(), ObjectKind::Table, col("z")),
                ("b".to_string(), ObjectKind::Table, col("a")),
                ("a".to_string(), ObjectKind::View, None),
            ],
        );
        assert_eq!(c.tables[0].name, "a");
        assert!(c.tables[0].columns.is_empty());
        let names: Vec<_> = c.tables[1]
            .columns
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(names, ["z", "a"]);
    }

    #[test]
    fn serde_shape_is_camel_case() {
        let c = Catalog {
            schema: None,
            tables: vec![CatalogTable {
                name: "t".into(),
                kind: ObjectKind::View,
                columns: vec![CatalogColumn {
                    name: "c".into(),
                    type_name: "int".into(),
                }],
            }],
        };
        assert_eq!(
            serde_json::to_value(&c).unwrap(),
            serde_json::json!({"schema": null, "tables": [{"name": "t", "kind": "view",
                "columns": [{"name": "c", "typeName": "int"}]}]})
        );
        assert_eq!(
            serde_json::to_value(DbRoutine {
                schema: Some("s".into()),
                name: "f".into(),
                kind: RoutineKind::Procedure
            })
            .unwrap(),
            serde_json::json!({"schema": "s", "name": "f", "kind": "procedure"})
        );
    }

    #[test]
    fn invalidate_blocks_a_fetch_started_before_it() {
        let cache = CatalogCache::new(CATALOG_TTL);
        let cat = Arc::new(Catalog {
            schema: None,
            tables: vec![],
        });
        let g = cache.generation("w");
        cache.invalidate("w");
        cache.put("w", None, g, cat.clone(), || true);
        assert!(cache.get("w", None).is_none());
        cache.put("w", None, cache.generation("w"), cat, || true);
        assert!(cache.get("w", None).is_some());
        cache.forget("w");
        assert!(cache.get("w", None).is_none());
    }
}
