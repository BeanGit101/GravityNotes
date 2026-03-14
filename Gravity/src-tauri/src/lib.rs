use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const TRASH_DIR_NAME: &str = ".gravity-trash";
const TRASH_ITEMS_DIR_NAME: &str = "items";
const TRASH_META_DIR_NAME: &str = "meta";
const DATA_DIR_NAME: &str = ".vault";
const LEGACY_APP_DIR_NAME: &str = ".gravity";
const TEMPLATES_DIR_NAME: &str = "templates";
const BACKUPS_DIR_NAME: &str = "backups";
const DB_FILE_NAME: &str = "app.db";
const METADATA_VERSION: i64 = 1;
const INDEX_STATUS_OK: &str = "ok";
const INDEX_STATUS_MISSING_FILE: &str = "missing_file";

const MIGRATION_1_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
  note_id TEXT PRIMARY KEY,
  note_rel_path TEXT UNIQUE NOT NULL,
  file_mtime_ms INTEGER,
  last_seen_scan INTEGER,
  file_exists INTEGER NOT NULL DEFAULT 1,
  index_status TEXT
);

CREATE TABLE IF NOT EXISTS note_metadata (
  note_id TEXT PRIMARY KEY REFERENCES notes(note_id) ON DELETE CASCADE,
  subject TEXT,
  created_at_unix_ms INTEGER,
  updated_at_unix_ms INTEGER
);

CREATE TABLE IF NOT EXISTS note_metadata_fields (
  note_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_integer INTEGER,
  value_number REAL,
  value_boolean INTEGER,
  value_json TEXT,
  PRIMARY KEY (note_id, field_name)
);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  tag_normalized TEXT NOT NULL,
  PRIMARY KEY (note_id, tag_normalized)
);

CREATE TABLE IF NOT EXISTS templates (
  template_rel_path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  last_indexed_at INTEGER NOT NULL,
  index_status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spellcheck_dictionary_words (
  word TEXT PRIMARY KEY,
  word_normalized TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  metadata_version INTEGER NOT NULL,
  last_backup_at INTEGER
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_note_rel_path ON notes(note_rel_path);
CREATE INDEX IF NOT EXISTS idx_notes_file_exists_rel_path ON notes(file_exists, note_rel_path);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag_normalized ON note_tags(tag_normalized);
CREATE INDEX IF NOT EXISTS idx_note_metadata_fields_field_name ON note_metadata_fields(field_name);
CREATE INDEX IF NOT EXISTS idx_note_metadata_fields_field_text ON note_metadata_fields(field_name, value_text);
CREATE INDEX IF NOT EXISTS idx_note_metadata_fields_field_integer ON note_metadata_fields(field_name, value_integer);
CREATE INDEX IF NOT EXISTS idx_note_metadata_fields_field_number ON note_metadata_fields(field_name, value_number);
CREATE INDEX IF NOT EXISTS idx_templates_updated_at ON templates(updated_at);
"#;

#[derive(Default)]
struct VaultState {
    selected_path: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Copy, Serialize)]
enum UpdatedAtSource {
    #[serde(rename = "metadata")]
    Metadata,
    #[serde(rename = "filesystem")]
    Filesystem,
}

#[derive(Serialize)]
struct Note {
    id: String,
    title: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject: Option<String>,
    tags: Vec<String>,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
    #[serde(rename = "updatedAtSource")]
    updated_at_source: UpdatedAtSource,
}

#[derive(Serialize)]
struct FolderItem {
    id: String,
    name: String,
    path: String,
    #[serde(rename = "type")]
    item_type: &'static str,
    children: Vec<FileSystemItem>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum FileSystemItem {
    #[serde(rename = "file")]
    File {
        id: String,
        title: String,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        subject: Option<String>,
        tags: Vec<String>,
        #[serde(rename = "updatedAt")]
        updated_at: i64,
        #[serde(rename = "updatedAtSource")]
        updated_at_source: UpdatedAtSource,
    },
    #[serde(rename = "folder")]
    Folder {
        id: String,
        name: String,
        path: String,
        children: Vec<FileSystemItem>,
    },
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum TrashItemType {
    File,
    Folder,
}

#[derive(Serialize, Deserialize, Clone)]
struct TrashedNoteRecord {
    note_id: String,
    note_rel_path: String,
}

#[derive(Serialize, Deserialize)]
struct TrashMetadata {
    id: String,
    name: String,
    original_relative_path: String,
    item_type: TrashItemType,
    deleted_at: u128,
    #[serde(default)]
    notes: Vec<TrashedNoteRecord>,
}

#[derive(Serialize)]
struct TrashEntry {
    id: String,
    name: String,
    original_path: String,
    #[serde(rename = "type")]
    item_type: TrashItemType,
    deleted_at: u128,
}

#[derive(Clone, Serialize)]
struct TemplateSummary {
    id: String,
    name: String,
    path: String,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
}

#[derive(Serialize)]
struct TemplateContent {
    id: String,
    name: String,
    path: String,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
}

#[derive(Serialize)]
struct TemplateItem {
    id: String,
    name: String,
    path: String,
    content: String,
}

struct ParsedTemplateSeed {
    body: String,
    subject: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum TemplateApplyMode {
    Replace,
    Prepend,
    Append,
}

#[derive(Clone)]
struct DbNoteSummary {
    note_id: String,
    note_rel_path: String,
    subject: Option<String>,
    tags: Vec<String>,
    updated_at: i64,
    updated_at_source: UpdatedAtSource,
}

#[derive(Serialize, Deserialize)]
struct MetadataBackup {
    metadata_version: i64,
    generated_at: i64,
    notes: Vec<MetadataBackupNote>,
}

#[derive(Serialize, Deserialize)]
struct MetadataBackupNote {
    note_id: String,
    note_rel_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at_unix_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at_unix_ms: Option<i64>,
    tags: Vec<String>,
    #[serde(default)]
    metadata_fields: BTreeMap<String, Value>,
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn normalize_markdown(content: &str) -> String {
    content.replace("\r\n", "\n")
}

fn timestamp_from_system_time(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i64,
        Err(_) => 0,
    }
}

fn current_timestamp_ms() -> i64 {
    timestamp_from_system_time(SystemTime::now())
}

fn current_timestamp_u128() -> u128 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis(),
        Err(_) => 0,
    }
}

fn modified_timestamp(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .map(timestamp_from_system_time)
        .unwrap_or_default()
}

fn iso_string_from_timestamp(timestamp: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(timestamp).map(|value| value.to_rfc3339())
}

fn parse_timestamp_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().or_else(|| number.as_f64().map(|entry| entry as i64)),
        Value::String(text) => parse_timestamp_str(text),
        _ => None,
    }
}

fn parse_timestamp_str(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(timestamp) = trimmed.parse::<i64>() {
        return Some(timestamp);
    }

    if let Ok(date_time) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(date_time.timestamp_millis());
    }

    if let Ok(date_time) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
        return Some(Utc.from_utc_datetime(&date_time).timestamp_millis());
    }

    if let Ok(date_time) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M") {
        return Some(Utc.from_utc_datetime(&date_time).timestamp_millis());
    }

    if let Ok(date) = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|date_time| Utc.from_utc_datetime(&date_time).timestamp_millis());
    }

    None
}

fn is_markdown_file(name: &str) -> bool {
    name.ends_with(".md") || name.ends_with(".MD")
}

fn normalize_relative_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn relative_path_from_vault(vault_path: &Path, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(vault_path).map_err(|_| {
        format!(
            "Path {} is outside the selected vault {}.",
            path.display(),
            vault_path.display()
        )
    })?;

    Ok(normalize_relative_path(relative))
}

fn absolute_path_from_relative(vault_path: &Path, relative_path: &str) -> PathBuf {
    relative_path
        .split('/')
        .filter(|part| !part.is_empty())
        .fold(vault_path.to_path_buf(), |current, segment| current.join(segment))
}

fn normalize_tag(tag: &str) -> Option<String> {
    let normalized = tag
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn normalize_tags(tags: &[Value]) -> Vec<String> {
    let mut seen = BTreeMap::<String, String>::new();
    for value in tags {
        let Some(text) = value.as_str() else {
            continue;
        };
        let Some(tag) = normalize_tag(text) else {
            continue;
        };
        seen.entry(tag.to_lowercase()).or_insert(tag);
    }
    seen.into_values().collect()
}

fn title_from_note_path(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| String::from("untitled"))
}

fn slugify(value: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;

    for character in value.trim().to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            output.push(character);
            previous_dash = false;
        } else if !previous_dash {
            output.push('-');
            previous_dash = true;
        }
    }

    output.trim_matches('-').to_string()
}

fn note_file_name(title: &str) -> String {
    let slug = slugify(title);
    format!("{}.md", if slug.is_empty() { "untitled" } else { slug.as_str() })
}

fn folder_name(name: &str) -> String {
    let slug = slugify(name);
    if slug.is_empty() {
        String::from("new-folder")
    } else {
        slug
    }
}

fn sanitize_template_name(value: &str) -> String {
    let mut output = String::new();
    let mut previous_space = false;

    for character in value.trim().chars() {
        let mapped = match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            other if other.is_control() => '-',
            other => other,
        };

        if mapped.is_whitespace() {
            if !previous_space {
                output.push(' ');
                previous_space = true;
            }
        } else {
            output.push(mapped);
            previous_space = false;
        }
    }

    let trimmed = output.trim_matches(|character| character == ' ' || character == '.');
    if trimmed.is_empty() {
        String::from("Untitled Template")
    } else {
        trimmed.to_string()
    }
}

fn clean_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
}

fn clean_optional_tags(tags: Option<Vec<String>>) -> Option<Vec<String>> {
    tags.map(|entries| {
        entries
            .into_iter()
            .filter_map(|entry| normalize_tag(&entry))
            .collect::<Vec<_>>()
    })
    .filter(|entries| !entries.is_empty())
}

fn serialize_template_markdown(seed: &ParsedTemplateSeed) -> String {
    let subject = clean_optional_string(seed.subject.clone());
    let tags = clean_optional_tags(seed.tags.clone());

    if subject.is_none() && tags.is_none() {
        return seed.body.clone();
    }

    let mut lines = vec![String::from("---")];

    if let Some(subject) = subject {
        lines.push(format!("subject: {subject}"));
    }

    if let Some(tags) = tags {
        lines.push(String::from("tags:"));
        for tag in tags {
            lines.push(format!("  - {tag}"));
        }
    }

    lines.push(String::from("---"));

    if !seed.body.is_empty() {
        lines.push(String::new());
        lines.push(seed.body.clone());
    }

    lines.join("\n")
}

fn parse_inline_tags(value: &str) -> Vec<String> {
    value
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|tag| tag.trim())
        .map(|tag| tag.trim_matches(|character| character == '"' || character == '\''))
        .filter(|tag| !tag.is_empty())
        .map(String::from)
        .collect()
}

fn parse_template_markdown(content: &str) -> ParsedTemplateSeed {
    let normalized = normalize_markdown(content);
    if !normalized.starts_with("---\n") {
        return ParsedTemplateSeed {
            body: normalized,
            subject: None,
            tags: None,
        };
    }

    let remaining = &normalized[4..];
    let closing_with_body = remaining.find("\n---\n");
    let closing_without_body = remaining.strip_suffix("\n---");

    let (frontmatter, body_with_spacing) = if let Some(index) = closing_with_body {
        (&remaining[..index], remaining[index + 5..].to_string())
    } else if let Some(frontmatter) = closing_without_body {
        (frontmatter, String::new())
    } else {
        return ParsedTemplateSeed {
            body: normalized,
            subject: None,
            tags: None,
        };
    };

    let body = body_with_spacing
        .strip_prefix('\n')
        .unwrap_or(&body_with_spacing)
        .to_string();

    let lines = frontmatter.lines().collect::<Vec<_>>();
    let mut subject = None;
    let mut tags = None;
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index].trim();
        if let Some(value) = line.strip_prefix("subject:") {
            subject = clean_optional_string(Some(value.trim().to_string()));
            index += 1;
            continue;
        }

        let Some(value) = line.strip_prefix("tags:") else {
            index += 1;
            continue;
        };

        let remainder = value.trim();
        if remainder.starts_with('[') && remainder.ends_with(']') {
            tags = clean_optional_tags(Some(parse_inline_tags(remainder)));
            index += 1;
            continue;
        }

        let mut collected = Vec::new();
        index += 1;
        while index < lines.len() {
            let item = lines[index].trim();
            let Some(tag) = item.strip_prefix("- ") else {
                break;
            };
            collected.push(
                tag.trim()
                    .trim_matches(|character| character == '"' || character == '\'')
                    .to_string(),
            );
            index += 1;
        }
        tags = clean_optional_tags(Some(collected));
    }

    ParsedTemplateSeed { body, subject, tags }
}

fn canonicalize_directory(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access directory {}: {error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("Path is not a directory: {}", canonical.display()));
    }
    Ok(canonical)
}

fn get_selected_vault(state: &tauri::State<VaultState>) -> Result<PathBuf, String> {
    let guard = state
        .selected_path
        .lock()
        .map_err(|_| String::from("Vault state lock poisoned"))?;
    guard
        .clone()
        .ok_or_else(|| String::from("No vault selected. Open a vault first."))
}

fn data_directory(vault_path: &Path) -> PathBuf {
    vault_path.join(DATA_DIR_NAME)
}

fn backups_directory(vault_path: &Path) -> PathBuf {
    data_directory(vault_path).join(BACKUPS_DIR_NAME)
}

fn database_path(vault_path: &Path) -> PathBuf {
    data_directory(vault_path).join(DB_FILE_NAME)
}

fn legacy_app_directory(vault_path: &Path) -> PathBuf {
    vault_path.join(LEGACY_APP_DIR_NAME)
}

fn templates_directory(vault_path: &Path) -> PathBuf {
    legacy_app_directory(vault_path).join(TEMPLATES_DIR_NAME)
}

fn trash_root(vault_path: &Path) -> PathBuf {
    vault_path.join(TRASH_DIR_NAME)
}

fn trash_items_directory(vault_path: &Path) -> PathBuf {
    trash_root(vault_path).join(TRASH_ITEMS_DIR_NAME)
}

fn trash_meta_directory(vault_path: &Path) -> PathBuf {
    trash_root(vault_path).join(TRASH_META_DIR_NAME)
}

fn stored_trash_path(vault_path: &Path, id: &str) -> PathBuf {
    trash_items_directory(vault_path).join(id)
}

fn metadata_path(vault_path: &Path, id: &str) -> PathBuf {
    trash_meta_directory(vault_path).join(format!("{id}.json"))
}

fn ensure_data_layout(vault_path: &Path) -> Result<(), String> {
    let data_path = data_directory(vault_path);
    fs::create_dir_all(&data_path)
        .map_err(|error| format!("Unable to create app data directory {}: {error}", data_path.display()))?;

    let backups_path = backups_directory(vault_path);
    fs::create_dir_all(&backups_path)
        .map_err(|error| format!("Unable to create backups directory {}: {error}", backups_path.display()))?;

    Ok(())
}

fn ensure_trash_layout(vault_path: &Path) -> Result<(), String> {
    let trash_items = trash_items_directory(vault_path);
    fs::create_dir_all(&trash_items)
        .map_err(|error| format!("Unable to create trash directory {}: {error}", trash_items.display()))?;

    let trash_meta = trash_meta_directory(vault_path);
    fs::create_dir_all(&trash_meta)
        .map_err(|error| format!("Unable to create trash metadata directory {}: {error}", trash_meta.display()))?;

    Ok(())
}

fn ensure_templates_layout(vault_path: &Path) -> Result<PathBuf, String> {
    let templates = templates_directory(vault_path);
    fs::create_dir_all(&templates)
        .map_err(|error| format!("Unable to create templates directory {}: {error}", templates.display()))?;
    canonicalize_directory(&templates)
}

fn is_inside_reserved_area(vault_path: &Path, path: &Path) -> bool {
    path.starts_with(trash_root(vault_path))
        || path.starts_with(data_directory(vault_path))
        || path.starts_with(legacy_app_directory(vault_path))
}

fn ensure_directory_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = canonicalize_directory(path)?;
    if !canonical.starts_with(vault_path) {
        return Err(String::from("Requested folder is outside the selected vault."));
    }
    if is_inside_reserved_area(vault_path, &canonical) {
        return Err(String::from("Requested folder is inside an app-managed directory."));
    }
    Ok(canonical)
}

fn ensure_can_manage_folder(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = ensure_directory_in_vault(vault_path, path)?;
    if canonical == *vault_path {
        return Err(String::from("The vault root cannot be renamed, moved, or deleted."));
    }
    Ok(canonical)
}

fn ensure_file_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access file {}: {error}", path.display()))?;
    if !canonical.starts_with(vault_path) {
        return Err(String::from("Requested file is outside the selected vault."));
    }
    if is_inside_reserved_area(vault_path, &canonical) {
        return Err(String::from("Requested file is inside an app-managed directory."));
    }
    if !canonical.is_file() {
        return Err(format!("Path is not a file: {}", canonical.display()));
    }
    Ok(canonical)
}

fn resolve_target_directory(vault_path: &Path, folder_path: Option<String>) -> Result<PathBuf, String> {
    match folder_path {
        Some(path) => ensure_directory_in_vault(vault_path, Path::new(path.trim())),
        None => Ok(vault_path.to_path_buf()),
    }
}

fn find_available_path(desired_path: &Path, is_file: bool) -> PathBuf {
    if !desired_path.exists() {
        return desired_path.to_path_buf();
    }

    let stem = desired_path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| String::from("untitled"));
    let extension = desired_path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()));
    let parent = desired_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    for index in 2.. {
        let candidate_name = if is_file {
            format!("{stem}-{index}{}", extension.as_deref().unwrap_or(""))
        } else {
            format!("{stem}-{index}")
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    desired_path.to_path_buf()
}

fn open_database(vault_path: &Path) -> Result<Connection, String> {
    ensure_data_layout(vault_path)?;
    let db_path = database_path(vault_path);
    let connection = Connection::open(&db_path)
        .map_err(|error| format!("Unable to open database {}: {error}", db_path.display()))?;
    apply_pragmas(&connection)?;
    run_migrations(&connection)?;
    Ok(connection)
}

fn apply_pragmas(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            PRAGMA foreign_keys=ON;
            PRAGMA temp_store=MEMORY;
            PRAGMA busy_timeout=5000;
            ",
        )
        .map_err(|error| format!("Unable to apply database PRAGMAs: {error}"))
}

fn run_migrations(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(MIGRATION_1_SQL)
        .map_err(|error| format!("Unable to initialize database schema: {error}"))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?1)",
            params![current_timestamp_ms()],
        )
        .map_err(|error| format!("Unable to record schema migration: {error}"))?;
    connection
        .execute(
            "
            INSERT INTO metadata_state (singleton_id, metadata_version, last_backup_at)
            VALUES (1, ?1, NULL)
            ON CONFLICT(singleton_id) DO UPDATE SET metadata_version = excluded.metadata_version
            ",
            params![METADATA_VERSION],
        )
        .map_err(|error| format!("Unable to initialize metadata state: {error}"))?;
    Ok(())
}

fn upsert_empty_note_metadata(
    transaction: &Transaction<'_>,
    note_id: &str,
    created_at: i64,
    updated_at: i64,
) -> Result<(), String> {
    transaction
        .execute(
            "
            INSERT INTO note_metadata (note_id, subject, created_at_unix_ms, updated_at_unix_ms)
            VALUES (?1, NULL, ?2, ?3)
            ON CONFLICT(note_id) DO NOTHING
            ",
            params![note_id, created_at, updated_at],
        )
        .map_err(|error| format!("Unable to initialize note metadata for {note_id}: {error}"))?;
    Ok(())
}

fn insert_note_record(
    transaction: &Transaction<'_>,
    note_id: &str,
    note_rel_path: &str,
    file_mtime_ms: i64,
    last_seen_scan: Option<i64>,
    created_at: i64,
) -> Result<(), String> {
    transaction
        .execute(
            "
            INSERT INTO notes (note_id, note_rel_path, file_mtime_ms, last_seen_scan, file_exists, index_status)
            VALUES (?1, ?2, ?3, ?4, 1, ?5)
            ",
            params![note_id, note_rel_path, file_mtime_ms, last_seen_scan, INDEX_STATUS_OK],
        )
        .map_err(|error| format!("Unable to create note record for {note_rel_path}: {error}"))?;
    upsert_empty_note_metadata(transaction, note_id, created_at, created_at.max(file_mtime_ms))
}

fn lookup_note_id_by_rel_path(connection: &Connection, note_rel_path: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT note_id FROM notes WHERE note_rel_path = ?1",
            params![note_rel_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Unable to load note record for {note_rel_path}: {error}"))
}

fn lookup_note_id_by_rel_path_tx(
    transaction: &Transaction<'_>,
    note_rel_path: &str,
) -> Result<Option<String>, String> {
    transaction
        .query_row(
            "SELECT note_id FROM notes WHERE note_rel_path = ?1",
            params![note_rel_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Unable to load note record for {note_rel_path}: {error}"))
}

fn ensure_note_registered(connection: &Connection, vault_path: &Path, note_path: &Path) -> Result<String, String> {
    let note_rel_path = relative_path_from_vault(vault_path, note_path)?;
    if let Some(note_id) = lookup_note_id_by_rel_path(connection, &note_rel_path)? {
        return Ok(note_id);
    }

    let metadata = fs::metadata(note_path)
        .map_err(|error| format!("Unable to read note metadata for {}: {error}", note_path.display()))?;
    let file_mtime_ms = modified_timestamp(&metadata);
    let created_at = current_timestamp_ms();
    let note_id = Uuid::new_v4().to_string();
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Unable to start note registration transaction: {error}"))?;
    insert_note_record(
        &transaction,
        &note_id,
        &note_rel_path,
        file_mtime_ms,
        None,
        created_at,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Unable to commit note registration for {note_rel_path}: {error}"))?;
    Ok(note_id)
}

fn parse_metadata_input(
    metadata: &Value,
) -> Result<(Option<String>, Vec<String>, Option<i64>, Option<i64>, BTreeMap<String, Value>), String> {
    let object = metadata
        .as_object()
        .ok_or_else(|| String::from("Note metadata must be a JSON object."))?;

    let subject = object
        .get("subject")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let tags = object
        .get("tags")
        .and_then(Value::as_array)
        .map(|entries| normalize_tags(entries))
        .unwrap_or_default();

    let created_at = object
        .get("createdAt")
        .or_else(|| object.get("created_at"))
        .and_then(parse_timestamp_value);
    let updated_at = object
        .get("updatedAt")
        .or_else(|| object.get("updated_at"))
        .and_then(parse_timestamp_value);

    let custom_fields = object
        .iter()
        .filter(|(key, _)| {
            *key != "subject"
                && *key != "tags"
                && *key != "createdAt"
                && *key != "updatedAt"
                && *key != "created_at"
                && *key != "updated_at"
        })
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();

    Ok((subject, tags, created_at, updated_at, custom_fields))
}

fn write_metadata_fields(
    transaction: &Transaction<'_>,
    note_id: &str,
    fields: &BTreeMap<String, Value>,
) -> Result<(), String> {
    transaction
        .execute(
            "DELETE FROM note_metadata_fields WHERE note_id = ?1",
            params![note_id],
        )
        .map_err(|error| format!("Unable to clear metadata fields for {note_id}: {error}"))?;

    for (field_name, value) in fields {
        let (value_type, value_text, value_integer, value_number, value_boolean, value_json) =
            match value {
                Value::String(text) => ("text", Some(text.clone()), None, None, None, None),
                Value::Number(number) => {
                    if let Some(integer) = number.as_i64() {
                        ("integer", None, Some(integer), None, None, None)
                    } else if let Some(number_value) = number.as_f64() {
                        ("number", None, None, Some(number_value), None, None)
                    } else {
                        ("json", None, None, None, None, Some(value.to_string()))
                    }
                }
                Value::Bool(boolean) => (
                    "boolean",
                    None,
                    None,
                    None,
                    Some(if *boolean { 1 } else { 0 }),
                    None,
                ),
                Value::Array(_) | Value::Object(_) => {
                    ("json", None, None, None, None, Some(value.to_string()))
                }
                Value::Null => continue,
            };

        transaction
            .execute(
                "
                INSERT INTO note_metadata_fields (
                  note_id,
                  field_name,
                  value_type,
                  value_text,
                  value_integer,
                  value_number,
                  value_boolean,
                  value_json
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ",
                params![
                    note_id,
                    field_name,
                    value_type,
                    value_text,
                    value_integer,
                    value_number,
                    value_boolean,
                    value_json,
                ],
            )
            .map_err(|error| format!("Unable to store metadata field {field_name} for {note_id}: {error}"))?;
    }

    Ok(())
}

fn write_note_tags(transaction: &Transaction<'_>, note_id: &str, tags: &[String]) -> Result<(), String> {
    transaction
        .execute("DELETE FROM note_tags WHERE note_id = ?1", params![note_id])
        .map_err(|error| format!("Unable to clear tags for {note_id}: {error}"))?;

    for tag in tags {
        transaction
            .execute(
                "INSERT INTO note_tags (note_id, tag, tag_normalized) VALUES (?1, ?2, ?3)",
                params![note_id, tag, tag.to_lowercase()],
            )
            .map_err(|error| format!("Unable to store tag {tag} for {note_id}: {error}"))?;
    }

    Ok(())
}

fn read_note_metadata_value(connection: &Connection, note_id: &str) -> Result<Value, String> {
    let row = connection
        .query_row(
            "
            SELECT subject, created_at_unix_ms, updated_at_unix_ms
            FROM note_metadata
            WHERE note_id = ?1
            ",
            params![note_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to read note metadata for {note_id}: {error}"))?;

    let mut output = Map::new();

    if let Some((subject, created_at, updated_at)) = row {
        if let Some(subject) = subject {
            output.insert(String::from("subject"), Value::String(subject));
        }
        if let Some(created_at) = created_at.and_then(iso_string_from_timestamp) {
            output.insert(String::from("createdAt"), Value::String(created_at));
        }
        if let Some(updated_at) = updated_at.and_then(iso_string_from_timestamp) {
            output.insert(String::from("updatedAt"), Value::String(updated_at));
        }
    }

    let mut tags = Vec::new();
    let mut tag_statement = connection
        .prepare("SELECT tag FROM note_tags WHERE note_id = ?1 ORDER BY tag_normalized, tag")
        .map_err(|error| format!("Unable to prepare tags query for {note_id}: {error}"))?;
    let tag_rows = tag_statement
        .query_map(params![note_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query tags for {note_id}: {error}"))?;
    for row in tag_rows {
        tags.push(Value::String(
            row.map_err(|error| format!("Unable to read tag for {note_id}: {error}"))?,
        ));
    }
    output.insert(String::from("tags"), Value::Array(tags));

    let mut field_statement = connection
        .prepare(
            "
            SELECT field_name, value_type, value_text, value_integer, value_number, value_boolean, value_json
            FROM note_metadata_fields
            WHERE note_id = ?1
            ORDER BY field_name
            ",
        )
        .map_err(|error| format!("Unable to prepare metadata fields query for {note_id}: {error}"))?;
    let field_rows = field_statement
        .query_map(params![note_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<f64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|error| format!("Unable to query metadata fields for {note_id}: {error}"))?;

    for row in field_rows {
        let (field_name, value_type, value_text, value_integer, value_number, value_boolean, value_json) =
            row.map_err(|error| format!("Unable to read metadata field for {note_id}: {error}"))?;
        let value = match value_type.as_str() {
            "text" => value_text.map(Value::String).unwrap_or(Value::Null),
            "integer" => value_integer.map(Value::from).unwrap_or(Value::Null),
            "number" => value_number.map(Value::from).unwrap_or(Value::Null),
            "boolean" => Value::Bool(value_boolean.unwrap_or_default() != 0),
            "json" => value_json
                .and_then(|entry| serde_json::from_str::<Value>(&entry).ok())
                .unwrap_or(Value::Null),
            _ => Value::Null,
        };
        if !value.is_null() {
            output.insert(field_name, value);
        }
    }

    Ok(Value::Object(output))
}

fn write_note_metadata_value(
    connection: &Connection,
    note_id: &str,
    metadata: &Value,
) -> Result<Value, String> {
    let (subject, tags, created_at_input, updated_at_input, custom_fields) = parse_metadata_input(metadata)?;
    let existing_created_at = connection
        .query_row(
            "SELECT created_at_unix_ms FROM note_metadata WHERE note_id = ?1",
            params![note_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to read existing metadata timestamps for {note_id}: {error}"))?
        .flatten();

    let created_at = created_at_input.or(existing_created_at).unwrap_or_else(current_timestamp_ms);
    let updated_at = updated_at_input.unwrap_or_else(current_timestamp_ms);

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Unable to start metadata write transaction for {note_id}: {error}"))?;
    transaction
        .execute(
            "
            INSERT INTO note_metadata (note_id, subject, created_at_unix_ms, updated_at_unix_ms)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(note_id) DO UPDATE SET
              subject = excluded.subject,
              created_at_unix_ms = excluded.created_at_unix_ms,
              updated_at_unix_ms = excluded.updated_at_unix_ms
            ",
            params![note_id, subject, created_at, updated_at],
        )
        .map_err(|error| format!("Unable to write note metadata for {note_id}: {error}"))?;
    write_note_tags(&transaction, note_id, &tags)?;
    write_metadata_fields(&transaction, note_id, &custom_fields)?;
    transaction
        .commit()
        .map_err(|error| format!("Unable to commit note metadata for {note_id}: {error}"))?;

    read_note_metadata_value(connection, note_id)
}

fn update_note_file_state(connection: &Connection, note_id: &str, file_mtime_ms: i64) -> Result<(), String> {
    connection
        .execute(
            "
            UPDATE notes
            SET file_mtime_ms = ?2,
                file_exists = 1,
                index_status = ?3
            WHERE note_id = ?1
            ",
            params![note_id, file_mtime_ms, INDEX_STATUS_OK],
        )
        .map_err(|error| format!("Unable to update note file state for {note_id}: {error}"))?;
    Ok(())
}

fn scan_markdown_files_in_directory(
    vault_path: &Path,
    directory: &Path,
    files: &mut Vec<(PathBuf, String, i64)>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Unable to scan directory {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read directory entry in {}: {error}", directory.display()))?;

    entries.sort_by(|left, right| {
        let left_name = left.file_name().to_string_lossy().to_ascii_lowercase();
        let right_name = right.file_name().to_string_lossy().to_ascii_lowercase();
        left_name.cmp(&right_name)
    });

    for entry in entries {
        let path = entry.path();
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to read file type for {}: {error}", path.display()))?;

        if file_type.is_dir() {
            if file_name == DATA_DIR_NAME || file_name == LEGACY_APP_DIR_NAME || file_name == TRASH_DIR_NAME {
                continue;
            }
            scan_markdown_files_in_directory(vault_path, &path, files)?;
            continue;
        }

        if !file_type.is_file() || !is_markdown_file(&file_name) {
            continue;
        }

        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Unable to read file metadata for {}: {error}", path.display()))?;
        files.push((
            path.clone(),
            relative_path_from_vault(vault_path, &path)?,
            modified_timestamp(&metadata),
        ));
    }

    Ok(())
}

fn scan_vault_notes_internal(connection: &Connection, vault_path: &Path) -> Result<usize, String> {
    let scan_id = current_timestamp_ms();
    let mut scanned_files = Vec::new();
    scan_markdown_files_in_directory(vault_path, vault_path, &mut scanned_files)?;

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Unable to start vault scan transaction: {error}"))?;

    for (_, note_rel_path, file_mtime_ms) in &scanned_files {
        if let Some(note_id) = lookup_note_id_by_rel_path_tx(&transaction, note_rel_path)? {
            transaction
                .execute(
                    "
                    UPDATE notes
                    SET file_mtime_ms = ?2,
                        last_seen_scan = ?3,
                        file_exists = 1,
                        index_status = ?4
                    WHERE note_id = ?1
                    ",
                    params![note_id, file_mtime_ms, scan_id, INDEX_STATUS_OK],
                )
                .map_err(|error| format!("Unable to update note during scan for {note_rel_path}: {error}"))?;
        } else {
            let note_id = Uuid::new_v4().to_string();
            insert_note_record(
                &transaction,
                &note_id,
                note_rel_path,
                *file_mtime_ms,
                Some(scan_id),
                current_timestamp_ms(),
            )?;
        }
    }

    transaction
        .execute(
            "
            UPDATE notes
            SET file_exists = 0,
                index_status = ?2
            WHERE file_exists = 1
              AND (last_seen_scan IS NULL OR last_seen_scan <> ?1)
            ",
            params![scan_id, INDEX_STATUS_MISSING_FILE],
        )
        .map_err(|error| format!("Unable to mark missing files after scan: {error}"))?;

    transaction
        .commit()
        .map_err(|error| format!("Unable to commit vault scan: {error}"))?;

    Ok(scanned_files.len())
}

fn load_note_summaries(connection: &Connection) -> Result<HashMap<String, DbNoteSummary>, String> {
    let mut note_statement = connection
        .prepare(
            "
            SELECT notes.note_id, notes.note_rel_path, notes.file_mtime_ms, note_metadata.subject, note_metadata.updated_at_unix_ms
            FROM notes
            LEFT JOIN note_metadata ON note_metadata.note_id = notes.note_id
            WHERE notes.file_exists = 1
            ",
        )
        .map_err(|error| format!("Unable to prepare note summary query: {error}"))?;
    let rows = note_statement
        .query_map([], |row| {
            let file_mtime_ms = row.get::<_, Option<i64>>(2)?.unwrap_or_default();
            let metadata_updated_at = row.get::<_, Option<i64>>(4)?;
            Ok(DbNoteSummary {
                note_id: row.get(0)?,
                note_rel_path: row.get(1)?,
                subject: row.get(3)?,
                tags: Vec::new(),
                updated_at: metadata_updated_at.unwrap_or(file_mtime_ms),
                updated_at_source: if metadata_updated_at.is_some() {
                    UpdatedAtSource::Metadata
                } else {
                    UpdatedAtSource::Filesystem
                },
            })
        })
        .map_err(|error| format!("Unable to query note summaries: {error}"))?;

    let mut summaries = HashMap::new();
    for row in rows {
        let summary = row.map_err(|error| format!("Unable to read note summary: {error}"))?;
        summaries.insert(summary.note_rel_path.clone(), summary);
    }

    let mut tag_statement = connection
        .prepare("SELECT note_id, tag FROM note_tags ORDER BY tag_normalized, tag")
        .map_err(|error| format!("Unable to prepare note tag query: {error}"))?;
    let tag_rows = tag_statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("Unable to query note tags: {error}"))?;

    let mut tags_by_note_id: HashMap<String, Vec<String>> = HashMap::new();
    for row in tag_rows {
        let (note_id, tag) = row.map_err(|error| format!("Unable to read note tag: {error}"))?;
        tags_by_note_id.entry(note_id).or_default().push(tag);
    }

    for summary in summaries.values_mut() {
        summary.tags = tags_by_note_id.remove(&summary.note_id).unwrap_or_default();
    }

    Ok(summaries)
}

fn build_note_from_summary(vault_path: &Path, summary: &DbNoteSummary) -> Note {
    let absolute_path = absolute_path_from_relative(vault_path, &summary.note_rel_path);
    Note {
        id: summary.note_id.clone(),
        title: title_from_note_path(&absolute_path),
        path: path_to_string(&absolute_path),
        subject: summary.subject.clone(),
        tags: summary.tags.clone(),
        updated_at: summary.updated_at,
        updated_at_source: summary.updated_at_source,
    }
}

fn list_directory_entries_recursive(
    vault_path: &Path,
    directory: &Path,
    summaries: &HashMap<String, DbNoteSummary>,
) -> Result<Vec<FileSystemItem>, String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Unable to read directory {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read directory entry in {}: {error}", directory.display()))?;

    entries.sort_by(|left, right| {
        let left_type = left.file_type().ok();
        let right_type = right.file_type().ok();
        let left_is_dir = left_type.map(|kind| kind.is_dir()).unwrap_or(false);
        let right_is_dir = right_type.map(|kind| kind.is_dir()).unwrap_or(false);
        right_is_dir
            .cmp(&left_is_dir)
            .then_with(|| left.file_name().to_string_lossy().to_ascii_lowercase().cmp(&right.file_name().to_string_lossy().to_ascii_lowercase()))
    });

    let mut items = Vec::new();
    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to read file type for {}: {error}", path.display()))?;
        let file_name = entry.file_name().to_string_lossy().into_owned();

        if file_type.is_dir() {
            if file_name == DATA_DIR_NAME || file_name == LEGACY_APP_DIR_NAME || file_name == TRASH_DIR_NAME {
                continue;
            }
            let children = list_directory_entries_recursive(vault_path, &path, summaries)?;
            items.push(FileSystemItem::Folder {
                id: path_to_string(&path),
                name: file_name,
                path: path_to_string(&path),
                children,
            });
            continue;
        }

        if !file_type.is_file() || !is_markdown_file(&file_name) {
            continue;
        }

        let note_rel_path = relative_path_from_vault(vault_path, &path)?;
        let Some(summary) = summaries.get(&note_rel_path) else {
            continue;
        };
        items.push(FileSystemItem::File {
            id: summary.note_id.clone(),
            title: title_from_note_path(&path),
            path: path_to_string(&path),
            subject: summary.subject.clone(),
            tags: summary.tags.clone(),
            updated_at: summary.updated_at,
            updated_at_source: summary.updated_at_source,
        });
    }

    Ok(items)
}

fn load_note_summary_by_note_id(connection: &Connection, note_id: &str) -> Result<Option<DbNoteSummary>, String> {
    let summaries = load_note_summaries(connection)?;
    Ok(summaries.into_values().find(|summary| summary.note_id == note_id))
}

fn update_note_path(connection: &Connection, note_id: &str, note_rel_path: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE notes SET note_rel_path = ?2, file_exists = 1, index_status = ?3 WHERE note_id = ?1",
            params![note_id, note_rel_path, INDEX_STATUS_OK],
        )
        .map_err(|error| format!("Unable to update note path for {note_id}: {error}"))?;
    Ok(())
}

fn write_trash_metadata(vault_path: &Path, metadata: &TrashMetadata) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(metadata)
        .map_err(|error| format!("Unable to serialize trash metadata {}: {error}", metadata.id))?;
    fs::write(metadata_path(vault_path, &metadata.id), serialized).map_err(|error| {
        format!(
            "Unable to write trash metadata {}: {error}",
            metadata_path(vault_path, &metadata.id).display()
        )
    })
}

fn read_trash_metadata(vault_path: &Path, id: &str) -> Result<TrashMetadata, String> {
    let path = metadata_path(vault_path, id);
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read trash metadata {}: {error}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Unable to parse trash metadata {}: {error}", path.display()))
}

fn list_trash(vault_path: &Path) -> Result<Vec<TrashEntry>, String> {
    ensure_trash_layout(vault_path)?;
    let mut entries = fs::read_dir(trash_meta_directory(vault_path))
        .map_err(|error| format!("Unable to read trash metadata directory: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read trash metadata entry: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());

    let mut trash_entries = Vec::new();
    for entry in entries {
        let path = entry.path();
        if entry.file_type().map(|value| !value.is_file()).unwrap_or(true) {
            continue;
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Unable to read trash metadata {}: {error}", path.display()))?;
        let metadata: TrashMetadata = serde_json::from_str(&content)
            .map_err(|error| format!("Unable to parse trash metadata {}: {error}", path.display()))?;
        trash_entries.push(TrashEntry {
            id: metadata.id,
            name: metadata.name,
            original_path: path_to_string(&absolute_path_from_relative(vault_path, &metadata.original_relative_path)),
            item_type: metadata.item_type,
            deleted_at: metadata.deleted_at,
        });
    }

    trash_entries.sort_by(|left, right| {
        right
            .deleted_at
            .cmp(&left.deleted_at)
            .then_with(|| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()))
    });

    Ok(trash_entries)
}

fn collect_note_records_for_file(
    connection: &Connection,
    vault_path: &Path,
    note_path: &Path,
) -> Result<Vec<TrashedNoteRecord>, String> {
    let note_rel_path = relative_path_from_vault(vault_path, note_path)?;
    let Some(note_id) = lookup_note_id_by_rel_path(connection, &note_rel_path)? else {
        return Ok(Vec::new());
    };
    Ok(vec![TrashedNoteRecord { note_id, note_rel_path }])
}

fn collect_note_records_for_folder(
    connection: &Connection,
    vault_path: &Path,
    folder_path: &Path,
) -> Result<Vec<TrashedNoteRecord>, String> {
    let folder_rel_path = relative_path_from_vault(vault_path, folder_path)?;
    let pattern = format!("{folder_rel_path}/%");
    let mut statement = connection
        .prepare(
            "
            SELECT note_id, note_rel_path
            FROM notes
            WHERE file_exists = 1
              AND (note_rel_path = ?1 OR note_rel_path LIKE ?2)
            ORDER BY note_rel_path
            ",
        )
        .map_err(|error| format!("Unable to prepare folder note lookup for {folder_rel_path}: {error}"))?;
    let rows = statement
        .query_map(params![folder_rel_path, pattern], |row| {
            Ok(TrashedNoteRecord {
                note_id: row.get(0)?,
                note_rel_path: row.get(1)?,
            })
        })
        .map_err(|error| format!("Unable to query notes for folder {folder_rel_path}: {error}"))?;

    let mut records = Vec::new();
    for row in rows {
        records.push(row.map_err(|error| format!("Unable to read folder note record: {error}"))?);
    }
    Ok(records)
}

fn mark_note_records_missing(connection: &Connection, records: &[TrashedNoteRecord]) -> Result<(), String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Unable to start note removal transaction: {error}"))?;
    for record in records {
        transaction
            .execute(
                "UPDATE notes SET file_exists = 0, index_status = ?2 WHERE note_id = ?1",
                params![record.note_id, INDEX_STATUS_MISSING_FILE],
            )
            .map_err(|error| format!("Unable to mark note {} as missing: {error}", record.note_id))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Unable to commit note removal transaction: {error}"))?;
    Ok(())
}

fn replace_relative_prefix(path: &str, from_prefix: &str, to_prefix: &str) -> String {
    if path == from_prefix {
        return to_prefix.to_string();
    }
    if let Some(remainder) = path.strip_prefix(&format!("{from_prefix}/")) {
        if to_prefix.is_empty() {
            return remainder.to_string();
        }
        return format!("{to_prefix}/{remainder}");
    }
    path.to_string()
}

fn restore_note_records(
    connection: &Connection,
    vault_path: &Path,
    metadata: &TrashMetadata,
    restore_path: &Path,
) -> Result<(), String> {
    let restored_prefix = relative_path_from_vault(vault_path, restore_path)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Unable to start restore transaction: {error}"))?;

    for record in &metadata.notes {
        let next_rel_path = match metadata.item_type {
            TrashItemType::File => restored_prefix.clone(),
            TrashItemType::Folder => replace_relative_prefix(
                &record.note_rel_path,
                &metadata.original_relative_path,
                &restored_prefix,
            ),
        };
        let absolute_path = absolute_path_from_relative(vault_path, &next_rel_path);
        let file_mtime_ms = fs::metadata(&absolute_path)
            .map(|details| modified_timestamp(&details))
            .unwrap_or_default();
        transaction
            .execute(
                "
                UPDATE notes
                SET note_rel_path = ?2,
                    file_mtime_ms = ?3,
                    file_exists = 1,
                    index_status = ?4
                WHERE note_id = ?1
                ",
                params![record.note_id, next_rel_path, file_mtime_ms, INDEX_STATUS_OK],
            )
            .map_err(|error| format!("Unable to restore note {}: {error}", record.note_id))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Unable to commit restore transaction: {error}"))?;
    Ok(())
}

fn permanently_delete_note_records(connection: &Connection, records: &[TrashedNoteRecord]) -> Result<(), String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Unable to start deletion transaction: {error}"))?;
    for record in records {
        transaction
            .execute("DELETE FROM notes WHERE note_id = ?1", params![record.note_id])
            .map_err(|error| format!("Unable to delete note record {}: {error}", record.note_id))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Unable to commit deletion transaction: {error}"))?;
    Ok(())
}

fn move_path_to_trash(
    connection: &Connection,
    vault_path: &Path,
    path: &Path,
    item_type: TrashItemType,
) -> Result<(), String> {
    ensure_trash_layout(vault_path)?;
    let id = Uuid::new_v4().to_string();
    let notes = match item_type {
        TrashItemType::File => collect_note_records_for_file(connection, vault_path, path)?,
        TrashItemType::Folder => collect_note_records_for_folder(connection, vault_path, path)?,
    };
    let metadata = TrashMetadata {
        id: id.clone(),
        name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| path_to_string(path)),
        original_relative_path: relative_path_from_vault(vault_path, path)?,
        item_type,
        deleted_at: current_timestamp_u128(),
        notes,
    };
    let target = stored_trash_path(vault_path, &id);
    fs::rename(path, &target).map_err(|error| {
        format!(
            "Unable to move {} to trash at {}: {error}",
            path.display(),
            target.display()
        )
    })?;
    write_trash_metadata(vault_path, &metadata)?;
    mark_note_records_missing(connection, &metadata.notes)?;
    write_daily_metadata_backup(vault_path, connection)?;
    Ok(())
}

fn restore_trash_item(connection: &Connection, vault_path: &Path, id: &str) -> Result<(), String> {
    let metadata = read_trash_metadata(vault_path, id)?;
    let source = stored_trash_path(vault_path, id);
    let desired = absolute_path_from_relative(vault_path, &metadata.original_relative_path);
    let restore_path = find_available_path(&desired, matches!(metadata.item_type, TrashItemType::File));
    let parent = restore_path.parent().ok_or_else(|| {
        format!(
            "Unable to determine restore target parent for {}.",
            restore_path.display()
        )
    })?;

    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create restore directory {}: {error}", parent.display()))?;
    fs::rename(&source, &restore_path).map_err(|error| {
        format!(
            "Unable to restore trash item {} to {}: {error}",
            source.display(),
            restore_path.display()
        )
    })?;
    restore_note_records(connection, vault_path, &metadata, &restore_path)?;
    fs::remove_file(metadata_path(vault_path, id)).map_err(|error| {
        format!(
            "Unable to remove trash metadata {}: {error}",
            metadata_path(vault_path, id).display()
        )
    })?;
    write_daily_metadata_backup(vault_path, connection)?;
    Ok(())
}

fn permanently_delete_trash_item(connection: &Connection, vault_path: &Path, id: &str) -> Result<(), String> {
    let metadata = read_trash_metadata(vault_path, id)?;
    let source = stored_trash_path(vault_path, id);

    match metadata.item_type {
        TrashItemType::File => fs::remove_file(&source)
            .map_err(|error| format!("Unable to delete trashed file {}: {error}", source.display()))?,
        TrashItemType::Folder => fs::remove_dir_all(&source)
            .map_err(|error| format!("Unable to delete trashed folder {}: {error}", source.display()))?,
    }

    permanently_delete_note_records(connection, &metadata.notes)?;
    fs::remove_file(metadata_path(vault_path, id)).map_err(|error| {
        format!(
            "Unable to remove trash metadata {}: {error}",
            metadata_path(vault_path, id).display()
        )
    })?;
    write_daily_metadata_backup(vault_path, connection)?;
    Ok(())
}

fn metadata_updated_at(path: &Path) -> Result<u64, String> {
    let modified = fs::metadata(path)
        .map_err(|error| format!("Unable to read metadata for {}: {error}", path.display()))?
        .modified()
        .map_err(|error| format!("Unable to read modified time for {}: {error}", path.display()))?;
    let duration = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Invalid modified time for {}: {error}", path.display()))?;
    Ok(duration.as_millis() as u64)
}

fn ensure_template_file_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let templates_path = ensure_templates_layout(vault_path)?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access template {}: {error}", path.display()))?;
    if !canonical.starts_with(&templates_path) {
        return Err(String::from(
            "Requested template is outside the managed templates directory.",
        ));
    }
    if !canonical.is_file() {
        return Err(format!("Template path is not a file: {}", canonical.display()));
    }

    let file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Invalid template file name: {}", canonical.display()))?;
    if !is_markdown_file(file_name) {
        return Err(format!(
            "Template must be a markdown file: {}",
            canonical.display()
        ));
    }

    Ok(canonical)
}

fn build_template_summary(path: &Path) -> Result<TemplateSummary, String> {
    Ok(TemplateSummary {
        id: path_to_string(path),
        name: path
            .file_stem()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| String::from("Untitled Template")),
        path: path_to_string(path),
        updated_at: metadata_updated_at(path)?,
    })
}

fn build_template_content(path: &Path) -> Result<TemplateContent, String> {
    let markdown = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read template {}: {error}", path.display()))?;
    let parsed = parse_template_markdown(&markdown);
    Ok(TemplateContent {
        id: path_to_string(path),
        name: path
            .file_stem()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| String::from("Untitled Template")),
        path: path_to_string(path),
        updated_at: metadata_updated_at(path)?,
        body: parsed.body,
        subject: parsed.subject,
        tags: parsed.tags,
    })
}

fn build_template_item(path: &Path) -> Result<TemplateItem, String> {
    let content = build_template_content(path)?;
    Ok(TemplateItem {
        id: content.id.clone(),
        name: content.name.clone(),
        path: content.path.clone(),
        content: serialize_template_markdown(&ParsedTemplateSeed {
            body: content.body,
            subject: content.subject,
            tags: content.tags,
        }),
    })
}

fn sort_templates(templates: &mut [TemplateSummary]) {
    templates.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()))
    });
}

fn sync_templates_index(connection: &Connection, vault_path: &Path) -> Result<(), String> {
    let templates_path = ensure_templates_layout(vault_path)?;
    let indexed_at = current_timestamp_ms();
    let mut templates = Vec::new();
    let entries = fs::read_dir(&templates_path)
        .map_err(|error| format!("Unable to read templates directory {}: {error}", templates_path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read template entry: {error}"))?;

    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to read template file type: {error}"))?;
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if file_type.is_file() && is_markdown_file(file_name) {
            templates.push(build_template_summary(&path)?);
        }
    }

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Unable to start template index transaction: {error}"))?;
    transaction
        .execute("DELETE FROM templates", [])
        .map_err(|error| format!("Unable to clear template index: {error}"))?;
    for template in templates {
        let relative_path = relative_path_from_vault(vault_path, Path::new(&template.path))?;
        transaction
            .execute(
                "
                INSERT INTO templates (template_rel_path, name, updated_at, last_indexed_at, index_status)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ",
                params![relative_path, template.name, template.updated_at as i64, indexed_at, INDEX_STATUS_OK],
            )
            .map_err(|error| format!("Unable to update template index for {}: {error}", template.path))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Unable to commit template index update: {error}"))?;
    Ok(())
}

fn export_metadata_backup(connection: &Connection) -> Result<MetadataBackup, String> {
    let mut note_statement = connection
        .prepare(
            "
            SELECT notes.note_id, notes.note_rel_path, note_metadata.subject, note_metadata.created_at_unix_ms, note_metadata.updated_at_unix_ms
            FROM notes
            LEFT JOIN note_metadata ON note_metadata.note_id = notes.note_id
            ORDER BY notes.note_rel_path
            ",
        )
        .map_err(|error| format!("Unable to prepare metadata backup query: {error}"))?;
    let note_rows = note_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })
        .map_err(|error| format!("Unable to query metadata backup notes: {error}"))?;

    let mut tags_by_note_id: HashMap<String, Vec<String>> = HashMap::new();
    let mut tag_statement = connection
        .prepare("SELECT note_id, tag FROM note_tags ORDER BY note_id, tag_normalized, tag")
        .map_err(|error| format!("Unable to prepare metadata backup tags query: {error}"))?;
    let tag_rows = tag_statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("Unable to query metadata backup tags: {error}"))?;
    for row in tag_rows {
        let (note_id, tag) = row.map_err(|error| format!("Unable to read metadata backup tag: {error}"))?;
        tags_by_note_id.entry(note_id).or_default().push(tag);
    }

    let mut fields_by_note_id: HashMap<String, BTreeMap<String, Value>> = HashMap::new();
    let mut field_statement = connection
        .prepare(
            "
            SELECT note_id, field_name, value_type, value_text, value_integer, value_number, value_boolean, value_json
            FROM note_metadata_fields
            ORDER BY note_id, field_name
            ",
        )
        .map_err(|error| format!("Unable to prepare metadata backup fields query: {error}"))?;
    let field_rows = field_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<f64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(|error| format!("Unable to query metadata backup fields: {error}"))?;
    for row in field_rows {
        let (note_id, field_name, value_type, value_text, value_integer, value_number, value_boolean, value_json) =
            row.map_err(|error| format!("Unable to read metadata backup field: {error}"))?;
        let value = match value_type.as_str() {
            "text" => value_text.map(Value::String).unwrap_or(Value::Null),
            "integer" => value_integer.map(Value::from).unwrap_or(Value::Null),
            "number" => value_number.map(Value::from).unwrap_or(Value::Null),
            "boolean" => Value::Bool(value_boolean.unwrap_or_default() != 0),
            "json" => value_json
                .and_then(|entry| serde_json::from_str::<Value>(&entry).ok())
                .unwrap_or(Value::Null),
            _ => Value::Null,
        };
        if !value.is_null() {
            fields_by_note_id.entry(note_id).or_default().insert(field_name, value);
        }
    }

    let mut notes = Vec::new();
    for row in note_rows {
        let (note_id, note_rel_path, subject, created_at_unix_ms, updated_at_unix_ms) =
            row.map_err(|error| format!("Unable to read metadata backup note: {error}"))?;
        notes.push(MetadataBackupNote {
            tags: tags_by_note_id.remove(&note_id).unwrap_or_default(),
            metadata_fields: fields_by_note_id.remove(&note_id).unwrap_or_default(),
            note_id,
            note_rel_path,
            subject,
            created_at_unix_ms,
            updated_at_unix_ms,
        });
    }

    Ok(MetadataBackup {
        metadata_version: METADATA_VERSION,
        generated_at: current_timestamp_ms(),
        notes,
    })
}

fn write_daily_metadata_backup(vault_path: &Path, connection: &Connection) -> Result<PathBuf, String> {
    ensure_data_layout(vault_path)?;
    let stamp = Utc::now().format("%Y%m%d").to_string();
    let backup_path = backups_directory(vault_path).join(format!("metadata-{stamp}.json"));
    let backup = export_metadata_backup(connection)?;
    let serialized = serde_json::to_string_pretty(&backup)
        .map_err(|error| format!("Unable to serialize metadata backup: {error}"))?;
    fs::write(&backup_path, serialized)
        .map_err(|error| format!("Unable to write metadata backup {}: {error}", backup_path.display()))?;
    connection
        .execute(
            "UPDATE metadata_state SET last_backup_at = ?1 WHERE singleton_id = 1",
            params![current_timestamp_ms()],
        )
        .map_err(|error| format!("Unable to update metadata backup state: {error}"))?;
    Ok(backup_path)
}

fn load_latest_backup_path(vault_path: &Path) -> Result<Option<PathBuf>, String> {
    let backups_path = backups_directory(vault_path);
    if !backups_path.exists() {
        return Ok(None);
    }
    let mut backups = fs::read_dir(&backups_path)
        .map_err(|error| format!("Unable to read backups directory {}: {error}", backups_path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read backup entry: {error}"))?;
    backups.retain(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false));
    backups.sort_by_key(|entry| entry.file_name());
    Ok(backups.last().map(|entry| entry.path()))
}

fn restore_metadata_backup(
    connection: &Connection,
    vault_path: &Path,
    backup_path: Option<PathBuf>,
) -> Result<(), String> {
    let resolved_backup = match backup_path {
        Some(path) => path,
        None => load_latest_backup_path(vault_path)?.ok_or_else(|| String::from("No metadata backup was found."))?,
    };
    let content = fs::read_to_string(&resolved_backup)
        .map_err(|error| format!("Unable to read metadata backup {}: {error}", resolved_backup.display()))?;
    let backup: MetadataBackup = serde_json::from_str(&content)
        .map_err(|error| format!("Unable to parse metadata backup {}: {error}", resolved_backup.display()))?;

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Unable to start metadata restore transaction: {error}"))?;
    for note in backup.notes {
        let absolute_path = absolute_path_from_relative(vault_path, &note.note_rel_path);
        let (file_exists, file_mtime_ms, index_status) = match fs::metadata(&absolute_path) {
            Ok(metadata) => (1, Some(modified_timestamp(&metadata)), INDEX_STATUS_OK),
            Err(_) => (0, None, INDEX_STATUS_MISSING_FILE),
        };
        transaction
            .execute(
                "
                INSERT INTO notes (note_id, note_rel_path, file_mtime_ms, last_seen_scan, file_exists, index_status)
                VALUES (?1, ?2, ?3, NULL, ?4, ?5)
                ON CONFLICT(note_id) DO UPDATE SET
                  note_rel_path = excluded.note_rel_path,
                  file_mtime_ms = excluded.file_mtime_ms,
                  file_exists = excluded.file_exists,
                  index_status = excluded.index_status
                ",
                params![note.note_id, note.note_rel_path, file_mtime_ms, file_exists, index_status],
            )
            .map_err(|error| format!("Unable to restore note record {}: {error}", note.note_id))?;
        transaction
            .execute(
                "
                INSERT INTO note_metadata (note_id, subject, created_at_unix_ms, updated_at_unix_ms)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(note_id) DO UPDATE SET
                  subject = excluded.subject,
                  created_at_unix_ms = excluded.created_at_unix_ms,
                  updated_at_unix_ms = excluded.updated_at_unix_ms
                ",
                params![
                    note.note_id,
                    note.subject,
                    note.created_at_unix_ms,
                    note.updated_at_unix_ms,
                ],
            )
            .map_err(|error| format!("Unable to restore note metadata {}: {error}", note.note_id))?;
        write_note_tags(&transaction, &note.note_id, &note.tags)?;
        write_metadata_fields(&transaction, &note.note_id, &note.metadata_fields)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Unable to commit metadata restore: {error}"))?;
    Ok(())
}

fn serialize_frontmatter_scalar(value: &Value) -> String {
    match value {
        Value::String(text) => serde_json::to_string(text).unwrap_or_else(|_| format!("\"{}\"", text)),
        Value::Number(number) => number.to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Null => String::from("null"),
        _ => serde_json::to_string(value).unwrap_or_else(|_| String::from("null")),
    }
}

fn build_export_frontmatter(path: &Path, metadata: &Value) -> Vec<String> {
    let mut lines = vec![String::from("---")];
    lines.push(format!(
        "title: {}",
        serialize_frontmatter_scalar(&Value::String(title_from_note_path(path)))
    ));

    if let Some(tags) = metadata.get("tags").and_then(Value::as_array) {
        lines.push(String::from("tags:"));
        for tag in tags {
            lines.push(format!("  - {}", serialize_frontmatter_scalar(tag)));
        }
    }

    if let Some(created) = metadata.get("createdAt") {
        lines.push(format!("created: {}", serialize_frontmatter_scalar(created)));
    }
    if let Some(updated) = metadata.get("updatedAt") {
        lines.push(format!("updated: {}", serialize_frontmatter_scalar(updated)));
    }

    let reserved = ["subject", "tags", "createdAt", "updatedAt", "created_at", "updated_at"];
    let mut custom_fields = metadata
        .as_object()
        .into_iter()
        .flat_map(|object| object.iter())
        .filter(|(key, _)| !reserved.contains(&key.as_str()))
        .collect::<Vec<_>>();
    custom_fields.sort_by(|left, right| left.0.cmp(right.0));

    for (key, value) in custom_fields {
        lines.push(format!("{key}: {}", serialize_frontmatter_scalar(value)));
    }

    lines.push(String::from("---"));
    lines
}

fn export_note_with_metadata_content(
    connection: &Connection,
    vault_path: &Path,
    note_path: &Path,
) -> Result<String, String> {
    let note_id = ensure_note_registered(connection, vault_path, note_path)?;
    let body = fs::read_to_string(note_path)
        .map_err(|error| format!("Unable to read note at {}: {error}", note_path.display()))?;
    let metadata = read_note_metadata_value(connection, &note_id)?;
    let mut lines = build_export_frontmatter(note_path, &metadata);
    if !body.is_empty() {
        lines.push(String::new());
        lines.push(body);
    }
    Ok(lines.join("\n"))
}

fn list_dictionary_words_internal(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare("SELECT word FROM spellcheck_dictionary_words ORDER BY word_normalized, word")
        .map_err(|error| format!("Unable to prepare dictionary query: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query dictionary words: {error}"))?;
    let mut words = Vec::new();
    for row in rows {
        words.push(row.map_err(|error| format!("Unable to read dictionary word: {error}"))?);
    }
    Ok(words)
}

fn add_dictionary_word_internal(connection: &Connection, word: &str) -> Result<(), String> {
    let trimmed = word.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    connection
        .execute(
            "
            INSERT INTO spellcheck_dictionary_words (word, word_normalized, created_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(word_normalized) DO UPDATE SET word = excluded.word
            ",
            params![trimmed, trimmed.to_lowercase(), current_timestamp_ms()],
        )
        .map_err(|error| format!("Unable to store dictionary word {trimmed}: {error}"))?;
    Ok(())
}

fn remove_dictionary_word_internal(connection: &Connection, word: &str) -> Result<(), String> {
    let trimmed = word.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    connection
        .execute(
            "DELETE FROM spellcheck_dictionary_words WHERE word_normalized = ?1",
            params![trimmed.to_lowercase()],
        )
        .map_err(|error| format!("Unable to remove dictionary word {trimmed}: {error}"))?;
    Ok(())
}

#[tauri::command]
fn set_vault_path(path: String, state: tauri::State<VaultState>) -> Result<String, String> {
    let canonical = canonicalize_directory(Path::new(&path))?;
    ensure_trash_layout(&canonical)?;
    ensure_data_layout(&canonical)?;
    let _ = open_database(&canonical)?;
    let mut guard = state
        .selected_path
        .lock()
        .map_err(|_| String::from("Vault state lock poisoned"))?;
    *guard = Some(canonical.clone());
    Ok(path_to_string(&canonical))
}

#[tauri::command]
fn scan_vault_notes(state: tauri::State<VaultState>) -> Result<usize, String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    scan_vault_notes_internal(&connection, &vault_path)
}

#[tauri::command]
fn list_vault_entries(state: tauri::State<VaultState>) -> Result<Vec<FileSystemItem>, String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    scan_vault_notes_internal(&connection, &vault_path)?;
    let summaries = load_note_summaries(&connection)?;
    list_directory_entries_recursive(&vault_path, &vault_path, &summaries)
}

#[tauri::command]
fn list_trash_entries(state: tauri::State<VaultState>) -> Result<Vec<TrashEntry>, String> {
    let vault_path = get_selected_vault(&state)?;
    list_trash(&vault_path)
}

#[tauri::command]
fn create_note(
    title: String,
    folder_path: Option<String>,
    initial_body: String,
    metadata: Option<Value>,
    state: tauri::State<VaultState>,
) -> Result<Note, String> {
    let vault_path = get_selected_vault(&state)?;
    let target_directory = resolve_target_directory(&vault_path, folder_path)?;
    let desired_path = target_directory.join(note_file_name(title.trim()));
    let note_path = find_available_path(&desired_path, true);
    let normalized_body = normalize_markdown(&initial_body);
    fs::write(&note_path, normalized_body)
        .map_err(|error| format!("Unable to create note at {}: {error}", note_path.display()))?;

    let connection = open_database(&vault_path)?;
    let file_mtime_ms = fs::metadata(&note_path)
        .map(|details| modified_timestamp(&details))
        .unwrap_or_else(|_| current_timestamp_ms());
    let created_at = current_timestamp_ms();
    let note_id = Uuid::new_v4().to_string();
    let note_rel_path = relative_path_from_vault(&vault_path, &note_path)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Unable to start note creation transaction: {error}"))?;
    insert_note_record(&transaction, &note_id, &note_rel_path, file_mtime_ms, None, created_at)?;
    transaction
        .commit()
        .map_err(|error| {
            let _ = fs::remove_file(&note_path);
            format!("Unable to commit note creation: {error}")
        })?;
    if let Some(metadata) = metadata.as_ref() {
        if let Err(error) = write_note_metadata_value(&connection, &note_id, metadata) {
            let _ = fs::remove_file(&note_path);
            return Err(error);
        }
    }
    write_daily_metadata_backup(&vault_path, &connection)?;

    let summary = load_note_summary_by_note_id(&connection, &note_id)?
        .ok_or_else(|| String::from("New note was not found after creation."))?;
    Ok(build_note_from_summary(&vault_path, &summary))
}

#[tauri::command]
fn rename_note(path: String, title: String, state: tauri::State<VaultState>) -> Result<Note, String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    let connection = open_database(&vault_path)?;
    let note_id = ensure_note_registered(&connection, &vault_path, &note_path)?;
    let parent = note_path.parent().ok_or_else(|| {
        format!(
            "Unable to determine note parent directory for {}.",
            note_path.display()
        )
    })?;
    let desired_path = parent.join(note_file_name(title.trim()));
    let next_path = if desired_path == note_path {
        note_path.clone()
    } else {
        find_available_path(&desired_path, true)
    };
    if next_path != note_path {
        fs::rename(&note_path, &next_path).map_err(|error| {
            format!(
                "Unable to rename note {} to {}: {error}",
                note_path.display(),
                next_path.display()
            )
        })?;
        let next_rel_path = relative_path_from_vault(&vault_path, &next_path)?;
        update_note_path(&connection, &note_id, &next_rel_path)?;
        let file_mtime_ms = fs::metadata(&next_path)
            .map(|details| modified_timestamp(&details))
            .unwrap_or_else(|_| current_timestamp_ms());
        update_note_file_state(&connection, &note_id, file_mtime_ms)?;
        write_daily_metadata_backup(&vault_path, &connection)?;
    }

    let summary = load_note_summary_by_note_id(&connection, &note_id)?
        .ok_or_else(|| String::from("Renamed note was not found."))?;
    Ok(build_note_from_summary(&vault_path, &summary))
}

#[tauri::command]
fn move_note(path: String, folder_path: Option<String>, state: tauri::State<VaultState>) -> Result<Note, String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    let connection = open_database(&vault_path)?;
    let note_id = ensure_note_registered(&connection, &vault_path, &note_path)?;
    let target_directory = resolve_target_directory(&vault_path, folder_path)?;
    let file_name = note_path.file_name().ok_or_else(|| {
        format!("Unable to determine note filename for {}.", note_path.display())
    })?;
    let desired_path = target_directory.join(file_name);
    let next_path = if desired_path == note_path {
        note_path.clone()
    } else {
        find_available_path(&desired_path, true)
    };
    if next_path != note_path {
        fs::rename(&note_path, &next_path).map_err(|error| {
            format!(
                "Unable to move note {} to {}: {error}",
                note_path.display(),
                next_path.display()
            )
        })?;
        let next_rel_path = relative_path_from_vault(&vault_path, &next_path)?;
        update_note_path(&connection, &note_id, &next_rel_path)?;
        let file_mtime_ms = fs::metadata(&next_path)
            .map(|details| modified_timestamp(&details))
            .unwrap_or_else(|_| current_timestamp_ms());
        update_note_file_state(&connection, &note_id, file_mtime_ms)?;
        write_daily_metadata_backup(&vault_path, &connection)?;
    }

    let summary = load_note_summary_by_note_id(&connection, &note_id)?
        .ok_or_else(|| String::from("Moved note was not found."))?;
    Ok(build_note_from_summary(&vault_path, &summary))
}

#[tauri::command]
fn create_folder(name: String, folder_path: Option<String>, state: tauri::State<VaultState>) -> Result<FolderItem, String> {
    let vault_path = get_selected_vault(&state)?;
    let target_directory = resolve_target_directory(&vault_path, folder_path)?;
    let desired_path = target_directory.join(folder_name(name.trim()));
    let folder_path = find_available_path(&desired_path, false);
    fs::create_dir_all(&folder_path)
        .map_err(|error| format!("Unable to create folder at {}: {error}", folder_path.display()))?;
    Ok(FolderItem {
        id: path_to_string(&folder_path),
        name: folder_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| String::from("folder")),
        path: path_to_string(&folder_path),
        item_type: "folder",
        children: Vec::new(),
    })
}

fn update_note_paths_for_folder_move(
    connection: &Connection,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<(), String> {
    let pattern = format!("{old_prefix}/%");
    let mut statement = connection
        .prepare(
            "
            SELECT note_id, note_rel_path
            FROM notes
            WHERE file_exists = 1
              AND (note_rel_path = ?1 OR note_rel_path LIKE ?2)
            ORDER BY note_rel_path
            ",
        )
        .map_err(|error| format!("Unable to prepare folder note update for {old_prefix}: {error}"))?;
    let rows = statement
        .query_map(params![old_prefix, pattern], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("Unable to query folder note update for {old_prefix}: {error}"))?;

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Unable to start folder note update transaction: {error}"))?;
    for row in rows {
        let (note_id, current_rel_path) = row.map_err(|error| format!("Unable to read folder note update row: {error}"))?;
        let next_rel_path = replace_relative_prefix(&current_rel_path, old_prefix, new_prefix);
        transaction
            .execute(
                "UPDATE notes SET note_rel_path = ?2 WHERE note_id = ?1",
                params![note_id, next_rel_path],
            )
            .map_err(|error| format!("Unable to update note path during folder move: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Unable to commit folder note update: {error}"))?;
    Ok(())
}

#[tauri::command]
fn rename_folder(path: String, name: String, state: tauri::State<VaultState>) -> Result<FolderItem, String> {
    let vault_path = get_selected_vault(&state)?;
    let folder_path = ensure_can_manage_folder(&vault_path, Path::new(path.trim()))?;
    let parent = folder_path.parent().ok_or_else(|| {
        format!(
            "Unable to determine folder parent directory for {}.",
            folder_path.display()
        )
    })?;
    let desired_path = parent.join(folder_name(name.trim()));
    let next_path = if desired_path == folder_path {
        folder_path.clone()
    } else {
        find_available_path(&desired_path, false)
    };

    if next_path != folder_path {
        fs::rename(&folder_path, &next_path).map_err(|error| {
            format!(
                "Unable to rename folder {} to {}: {error}",
                folder_path.display(),
                next_path.display()
            )
        })?;
        let connection = open_database(&vault_path)?;
        update_note_paths_for_folder_move(
            &connection,
            &relative_path_from_vault(&vault_path, &folder_path)?,
            &relative_path_from_vault(&vault_path, &next_path)?,
        )?;
        write_daily_metadata_backup(&vault_path, &connection)?;
    }

    Ok(FolderItem {
        id: path_to_string(&next_path),
        name: next_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| String::from("folder")),
        path: path_to_string(&next_path),
        item_type: "folder",
        children: Vec::new(),
    })
}

#[tauri::command]
fn move_folder(path: String, folder_path: Option<String>, state: tauri::State<VaultState>) -> Result<FolderItem, String> {
    let vault_path = get_selected_vault(&state)?;
    let source_path = ensure_can_manage_folder(&vault_path, Path::new(path.trim()))?;
    let target_directory = resolve_target_directory(&vault_path, folder_path)?;
    if target_directory.starts_with(&source_path) {
        return Err(String::from("A folder cannot be moved into itself or one of its descendants."));
    }
    let name = source_path.file_name().ok_or_else(|| {
        format!("Unable to determine folder name for {}.", source_path.display())
    })?;
    let desired_path = target_directory.join(name);
    let next_path = if desired_path == source_path {
        source_path.clone()
    } else {
        find_available_path(&desired_path, false)
    };
    if next_path.starts_with(&source_path) {
        return Err(String::from("A folder cannot be moved into itself or one of its descendants."));
    }

    if next_path != source_path {
        fs::rename(&source_path, &next_path).map_err(|error| {
            format!(
                "Unable to move folder {} to {}: {error}",
                source_path.display(),
                next_path.display()
            )
        })?;
        let connection = open_database(&vault_path)?;
        update_note_paths_for_folder_move(
            &connection,
            &relative_path_from_vault(&vault_path, &source_path)?,
            &relative_path_from_vault(&vault_path, &next_path)?,
        )?;
        write_daily_metadata_backup(&vault_path, &connection)?;
    }

    Ok(FolderItem {
        id: path_to_string(&next_path),
        name: next_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| String::from("folder")),
        path: path_to_string(&next_path),
        item_type: "folder",
        children: Vec::new(),
    })
}

#[tauri::command]
fn read_note(path: String, state: tauri::State<VaultState>) -> Result<String, String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    fs::read_to_string(&note_path)
        .map_err(|error| format!("Unable to read note at {}: {error}", note_path.display()))
}

#[tauri::command]
fn write_note(path: String, content: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    fs::write(&note_path, normalize_markdown(&content))
        .map_err(|error| format!("Unable to write note at {}: {error}", note_path.display()))?;
    let connection = open_database(&vault_path)?;
    let note_id = ensure_note_registered(&connection, &vault_path, &note_path)?;
    let file_mtime_ms = fs::metadata(&note_path)
        .map(|details| modified_timestamp(&details))
        .unwrap_or_else(|_| current_timestamp_ms());
    update_note_file_state(&connection, &note_id, file_mtime_ms)
}

#[tauri::command]
fn read_note_metadata(path: String, state: tauri::State<VaultState>) -> Result<Value, String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    let connection = open_database(&vault_path)?;
    let note_id = ensure_note_registered(&connection, &vault_path, &note_path)?;
    read_note_metadata_value(&connection, &note_id)
}

#[tauri::command]
fn write_note_metadata(path: String, metadata: Value, state: tauri::State<VaultState>) -> Result<Value, String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    let connection = open_database(&vault_path)?;
    let note_id = ensure_note_registered(&connection, &vault_path, &note_path)?;
    let written = write_note_metadata_value(&connection, &note_id, &metadata)?;
    write_daily_metadata_backup(&vault_path, &connection)?;
    Ok(written)
}

#[tauri::command]
fn export_note_with_metadata(
    path: String,
    destination_path: Option<String>,
    state: tauri::State<VaultState>,
) -> Result<String, String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    let connection = open_database(&vault_path)?;
    let content = export_note_with_metadata_content(&connection, &vault_path, &note_path)?;
    if let Some(destination_path) = destination_path {
        let destination = PathBuf::from(destination_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Unable to create export directory {}: {error}", parent.display()))?;
        }
        fs::write(&destination, &content)
            .map_err(|error| format!("Unable to write exported note {}: {error}", destination.display()))?;
        return Ok(path_to_string(&destination));
    }
    Ok(content)
}

#[tauri::command]
fn export_vault_metadata_backup(state: tauri::State<VaultState>) -> Result<String, String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    let backup_path = write_daily_metadata_backup(&vault_path, &connection)?;
    Ok(path_to_string(&backup_path))
}

#[tauri::command]
fn restore_metadata_from_backup(
    backup_path: Option<String>,
    state: tauri::State<VaultState>,
) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    restore_metadata_backup(&connection, &vault_path, backup_path.map(PathBuf::from))
}

#[tauri::command]
fn list_templates(state: tauri::State<VaultState>) -> Result<Vec<TemplateSummary>, String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    sync_templates_index(&connection, &vault_path)?;
    let templates_path = ensure_templates_layout(&vault_path)?;
    let entries = fs::read_dir(&templates_path)
        .map_err(|error| format!("Unable to read templates directory {}: {error}", templates_path.display()))?;

    let mut templates = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read template entry: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to read template file type: {error}"))?;
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if file_type.is_file() && is_markdown_file(file_name) {
            templates.push(build_template_summary(&path)?);
        }
    }

    sort_templates(&mut templates);
    Ok(templates)
}

#[tauri::command]
fn create_template(
    name: String,
    body: String,
    subject: Option<String>,
    tags: Option<Vec<String>>,
    state: tauri::State<VaultState>,
) -> Result<TemplateContent, String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    let templates_path = ensure_templates_layout(&vault_path)?;
    let desired_path = templates_path.join(format!("{}.md", sanitize_template_name(name.trim())));
    let template_path = find_available_path(&desired_path, true);
    let markdown = serialize_template_markdown(&ParsedTemplateSeed {
        body: normalize_markdown(&body),
        subject,
        tags,
    });
    fs::write(&template_path, markdown)
        .map_err(|error| format!("Unable to create template at {}: {error}", template_path.display()))?;
    sync_templates_index(&connection, &vault_path)?;
    build_template_content(&template_path)
}

#[tauri::command]
fn read_template(path: String, state: tauri::State<VaultState>) -> Result<TemplateContent, String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file_in_vault(&vault_path, Path::new(path.trim()))?;
    build_template_content(&template_path)
}

#[tauri::command]
fn rename_template(path: String, new_name: String, state: tauri::State<VaultState>) -> Result<TemplateSummary, String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    let template_path = ensure_template_file_in_vault(&vault_path, Path::new(path.trim()))?;
    let templates_path = ensure_templates_layout(&vault_path)?;
    let desired_path = templates_path.join(format!("{}.md", sanitize_template_name(new_name.trim())));
    let next_path = if desired_path == template_path {
        template_path.clone()
    } else {
        find_available_path(&desired_path, true)
    };

    if next_path != template_path {
        fs::rename(&template_path, &next_path).map_err(|error| {
            format!(
                "Unable to rename template {} to {}: {error}",
                template_path.display(),
                next_path.display()
            )
        })?;
    }

    sync_templates_index(&connection, &vault_path)?;
    build_template_summary(&next_path)
}

#[tauri::command]
fn update_template(path: String, name: Option<String>, content: Option<String>, state: tauri::State<VaultState>) -> Result<TemplateItem, String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    let template_path = ensure_template_file_in_vault(&vault_path, Path::new(path.trim()))?;
    let next_path = if let Some(next_name) = name {
        let templates_path = ensure_templates_layout(&vault_path)?;
        let desired_path = templates_path.join(format!("{}.md", sanitize_template_name(next_name.trim())));
        if desired_path == template_path {
            template_path.clone()
        } else {
            find_available_path(&desired_path, true)
        }
    } else {
        template_path.clone()
    };

    if next_path != template_path {
        fs::rename(&template_path, &next_path).map_err(|error| {
            format!(
                "Unable to rename template {} to {}: {error}",
                template_path.display(),
                next_path.display()
            )
        })?;
    }

    if let Some(next_content) = content {
        fs::write(&next_path, normalize_markdown(&next_content))
            .map_err(|error| format!("Unable to update template {}: {error}", next_path.display()))?;
    }

    sync_templates_index(&connection, &vault_path)?;
    build_template_item(&next_path)
}

#[tauri::command]
fn delete_template(path: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    let template_path = ensure_template_file_in_vault(&vault_path, Path::new(path.trim()))?;
    fs::remove_file(&template_path)
        .map_err(|error| format!("Unable to delete template {}: {error}", template_path.display()))?;
    sync_templates_index(&connection, &vault_path)
}

#[tauri::command]
fn apply_template(template_path: String, note_path: String, mode: TemplateApplyMode, state: tauri::State<VaultState>) -> Result<String, String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file_in_vault(&vault_path, Path::new(template_path.trim()))?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(note_path.trim()))?;
    let template_content = fs::read_to_string(&template_path)
        .map_err(|error| format!("Unable to read template {}: {error}", template_path.display()))?;
    let template_body = parse_template_markdown(&template_content).body;
    let existing_content = fs::read_to_string(&note_path)
        .map_err(|error| format!("Unable to read note {}: {error}", note_path.display()))?;

    let next_content = match mode {
        TemplateApplyMode::Replace => template_body,
        TemplateApplyMode::Prepend => format!("{template_body}{existing_content}"),
        TemplateApplyMode::Append => format!("{existing_content}{template_body}"),
    };

    fs::write(&note_path, &next_content)
        .map_err(|error| format!("Unable to apply template to {}: {error}", note_path.display()))?;
    let connection = open_database(&vault_path)?;
    let note_id = ensure_note_registered(&connection, &vault_path, &note_path)?;
    let file_mtime_ms = fs::metadata(&note_path)
        .map(|details| modified_timestamp(&details))
        .unwrap_or_else(|_| current_timestamp_ms());
    update_note_file_state(&connection, &note_id, file_mtime_ms)?;
    Ok(next_content)
}

#[tauri::command]
fn delete_note(path: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    let connection = open_database(&vault_path)?;
    move_path_to_trash(&connection, &vault_path, &note_path, TrashItemType::File)
}

#[tauri::command]
fn delete_folder(path: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let folder_path = ensure_can_manage_folder(&vault_path, Path::new(path.trim()))?;
    let connection = open_database(&vault_path)?;
    move_path_to_trash(&connection, &vault_path, &folder_path, TrashItemType::Folder)
}

#[tauri::command]
fn restore_trash_entry(id: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    restore_trash_item(&connection, &vault_path, id.trim())
}

#[tauri::command]
fn permanently_delete_trash_entry(id: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    permanently_delete_trash_item(&connection, &vault_path, id.trim())
}

#[tauri::command]
fn list_dictionary_words(state: tauri::State<VaultState>) -> Result<Vec<String>, String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    list_dictionary_words_internal(&connection)
}

#[tauri::command]
fn add_dictionary_word(word: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    add_dictionary_word_internal(&connection, &word)
}

#[tauri::command]
fn remove_dictionary_word(word: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let connection = open_database(&vault_path)?;
    remove_dictionary_word_internal(&connection, &word)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(VaultState::default())
        .invoke_handler(tauri::generate_handler![
            set_vault_path,
            scan_vault_notes,
            list_vault_entries,
            list_trash_entries,
            create_note,
            rename_note,
            move_note,
            create_folder,
            rename_folder,
            move_folder,
            read_note,
            write_note,
            read_note_metadata,
            write_note_metadata,
            export_note_with_metadata,
            export_vault_metadata_backup,
            restore_metadata_from_backup,
            delete_note,
            delete_folder,
            restore_trash_entry,
            permanently_delete_trash_entry,
            list_templates,
            create_template,
            read_template,
            rename_template,
            update_template,
            delete_template,
            apply_template,
            list_dictionary_words,
            add_dictionary_word,
            remove_dictionary_word
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


