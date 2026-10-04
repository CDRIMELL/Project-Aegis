//! Conversion between JSON values crossing IPC and SQLite values.

use rusqlite::types::{Value as SqlValue, ValueRef};
use serde_json::Value as JsonValue;

use crate::error::{AppError, AppResult};

pub fn to_sql(value: &JsonValue) -> AppResult<SqlValue> {
    match value {
        JsonValue::Null => Ok(SqlValue::Null),
        JsonValue::Bool(flag) => Ok(SqlValue::Integer(i64::from(*flag))),
        JsonValue::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Ok(SqlValue::Integer(integer))
            } else if number.is_u64() {
                Err(AppError::UnsupportedValue(
                    "integer parameter exceeds the signed 64-bit range".into(),
                ))
            } else {
                number.as_f64().map(SqlValue::Real).ok_or_else(|| {
                    AppError::UnsupportedValue("number parameter is not representable".into())
                })
            }
        }
        JsonValue::String(text) => Ok(SqlValue::Text(text.clone())),
        JsonValue::Array(_) | JsonValue::Object(_) => Err(AppError::UnsupportedValue(
            "array and object parameters are not supported".into(),
        )),
    }
}

pub fn from_sql(value: ValueRef<'_>) -> AppResult<JsonValue> {
    match value {
        ValueRef::Null => Ok(JsonValue::Null),
        ValueRef::Integer(integer) => Ok(JsonValue::from(integer)),
        // JSON cannot carry NaN or infinities; SQLite stores NaN as NULL anyway.
        ValueRef::Real(real) => Ok(serde_json::Number::from_f64(real)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null)),
        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
            .map(|text| JsonValue::String(text.to_owned()))
            .map_err(|_| AppError::UnsupportedValue("text column is not valid UTF-8".into())),
        ValueRef::Blob(_) => Err(AppError::UnsupportedValue(
            "blob columns are not supported over IPC".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converts_scalars_to_sql() {
        assert_eq!(to_sql(&json!(null)).unwrap(), SqlValue::Null);
        assert_eq!(to_sql(&json!(true)).unwrap(), SqlValue::Integer(1));
        assert_eq!(to_sql(&json!(false)).unwrap(), SqlValue::Integer(0));
        assert_eq!(to_sql(&json!(42)).unwrap(), SqlValue::Integer(42));
        assert_eq!(to_sql(&json!(1.5)).unwrap(), SqlValue::Real(1.5));
        assert_eq!(to_sql(&json!("abc")).unwrap(), SqlValue::Text("abc".into()));
    }

    #[test]
    fn rejects_structured_and_out_of_range_parameters() {
        assert!(to_sql(&json!([1, 2])).is_err());
        assert!(to_sql(&json!({"a": 1})).is_err());
        assert!(to_sql(&json!(u64::MAX)).is_err());
    }

    #[test]
    fn converts_sql_to_json() {
        assert_eq!(from_sql(ValueRef::Null).unwrap(), json!(null));
        assert_eq!(from_sql(ValueRef::Integer(7)).unwrap(), json!(7));
        assert_eq!(from_sql(ValueRef::Real(0.25)).unwrap(), json!(0.25));
        assert_eq!(from_sql(ValueRef::Text(b"hi")).unwrap(), json!("hi"));
        assert!(from_sql(ValueRef::Blob(&[1, 2])).is_err());
        assert!(from_sql(ValueRef::Text(&[0xff, 0xfe])).is_err());
    }
}
