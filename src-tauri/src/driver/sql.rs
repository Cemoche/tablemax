use super::{Dialect, ObjectRef, PageRequest, SortDir};

pub fn quote_ident(d: Dialect, ident: &str) -> String {
    match d {
        Dialect::MySql => format!("`{}`", ident.replace('`', "``")),
        Dialect::Postgres | Dialect::Sqlite => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

pub fn qualified(d: Dialect, obj: &ObjectRef) -> String {
    match &obj.schema {
        Some(s) => format!("{}.{}", quote_ident(d, s), quote_ident(d, &obj.name)),
        None => quote_ident(d, &obj.name),
    }
}

pub fn build_page_query(d: Dialect, req: &PageRequest) -> String {
    let mut sql = format!("SELECT * FROM {}", qualified(d, &req.object));
    if let Some((col, dir)) = &req.sort {
        let dir = match dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };
        sql.push_str(&format!(" ORDER BY {} {dir}", quote_ident(d, col)));
    }
    sql.push_str(&format!(" LIMIT {} OFFSET {}", req.limit, req.offset));
    sql
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quote_ident_escapes_per_dialect() {
        assert_eq!(
            quote_ident(Dialect::Postgres, r#"My "Table""#),
            r#""My ""Table""""#
        );
        assert_eq!(quote_ident(Dialect::Sqlite, "order"), r#""order""#);
        assert_eq!(quote_ident(Dialect::MySql, "we`ird"), "`we``ird`");
    }
    #[test]
    fn page_query_with_sort_and_schema() {
        let req = PageRequest {
            object: ObjectRef {
                schema: Some("public".into()),
                name: "orders".into(),
            },
            limit: 300,
            offset: 600,
            sort: Some(("total".into(), SortDir::Desc)),
        };
        assert_eq!(
            build_page_query(Dialect::Postgres, &req),
            r#"SELECT * FROM "public"."orders" ORDER BY "total" DESC LIMIT 300 OFFSET 600"#
        );
    }
    #[test]
    fn page_query_without_sort_mysql() {
        let req = PageRequest {
            object: ObjectRef {
                schema: Some("shop".into()),
                name: "order".into(),
            },
            limit: 10,
            offset: 0,
            sort: None,
        };
        assert_eq!(
            build_page_query(Dialect::MySql, &req),
            "SELECT * FROM `shop`.`order` LIMIT 10 OFFSET 0"
        );
    }
}
