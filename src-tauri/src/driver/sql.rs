use super::{Dialect, ObjectRef};

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
}
