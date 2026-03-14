use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use uuid::Uuid;

const TRASH_DIR_NAME: &str = ".gravity-trash";
const TRASH_ITEMS_DIR_NAME: &str = "items";
const TRASH_META_DIR_NAME: &str = "meta";
const APP_DIR_NAME: &str = ".gravity";
const TEMPLATES_DIR_NAME: &str = "templates";
const MEMORIES_FILE_NAME: &str = "memories.json";

#[derive(Default)]
struct VaultState {
    selected_path: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Copy, Serialize)]
enum UpdatedAtSource {
    #[serde(rename = "frontmatter")]
    Frontmatter,
    #[serde(rename = "filesystem")]
    Filesystem,
}

#[derive(Serialize)]
struct Note {
    id: String,
    title: String,
    path: String,
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

#[derive(Default)]
struct ParsedFrontmatter {
    updated_at: Option<i64>,
    tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum TrashItemType {
    File,
    Folder,
}

#[derive(Serialize, Deserialize)]
struct TrashMetadata {
    id: String,
    name: String,
    original_relative_path: String,
    item_type: TrashItemType,
    deleted_at: u128,
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

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
struct Memory {
    id: String,
    title: String,
    content: String,
    #[serde(rename = "originNote")]
    origin_note: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: String,
}

#[derive(Serialize, PartialEq, Eq, Debug)]
struct DeleteMemoryResult {
    success: bool,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum TemplateApplyMode {
    Replace,
    Prepend,
    Append,
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn is_markdown_file(name: &str) -> bool {
    name.ends_with(".md") || name.ends_with(".MD")
}

fn strip_markdown_extension(name: &str) -> &str {
    name.strip_suffix(".md")
        .or_else(|| name.strip_suffix(".MD"))
        .unwrap_or(name)
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

fn modified_timestamp(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .map(timestamp_from_system_time)
        .unwrap_or_default()
}

fn push_unique_tag(tags: &mut Vec<String>, raw_value: &str) {
    let trimmed = raw_value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .trim_start_matches('#');
    if trimmed.is_empty() {
        return;
    }

    if tags.iter().any(|tag| tag.eq_ignore_ascii_case(trimmed)) {
        return;
    }

    tags.push(trimmed.to_string());
}

fn collect_inline_tags(value: &str, tags: &mut Vec<String>) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }

    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        let inner = &trimmed[1..trimmed.len() - 1];
        for part in inner.split(',') {
            push_unique_tag(tags, part);
        }
        return;
    }

    for part in trimmed.split(',') {
        push_unique_tag(tags, part);
    }
}

fn parse_frontmatter_timestamp(value: &str) -> Option<i64> {
    let trimmed = value.trim().trim_matches('"').trim_matches('\'').trim();
    if trimmed.is_empty() {
        return None;
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

fn parse_frontmatter(content: &str) -> ParsedFrontmatter {
    let mut lines = content.lines();
    let Some(first_line) = lines.next() else {
        return ParsedFrontmatter::default();
    };

    if first_line.trim() != "---" {
        return ParsedFrontmatter::default();
    }

    let mut frontmatter = ParsedFrontmatter::default();
    let mut current_key: Option<&str> = None;

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" || trimmed == "..." {
            break;
        }

        if let Some(value) = line
            .strip_prefix("updatedAt:")
            .or_else(|| line.strip_prefix("updated:"))
        {
            frontmatter.updated_at = parse_frontmatter_timestamp(value);
            current_key = None;
            continue;
        }

        if let Some(value) = line.strip_prefix("tags:") {
            let trimmed_value = value.trim();
            if trimmed_value.is_empty() {
                current_key = Some("tags");
            } else {
                collect_inline_tags(trimmed_value, &mut frontmatter.tags);
                current_key = None;
            }
            continue;
        }

        if current_key == Some("tags") {
            if let Some(value) = trimmed.strip_prefix("- ") {
                push_unique_tag(&mut frontmatter.tags, value);
                continue;
            }

            if trimmed.is_empty() {
                continue;
            }

            current_key = None;
        }
    }

    frontmatter
}

fn build_note_metadata(note_path: &Path, metadata: &fs::Metadata) -> (Vec<String>, i64, UpdatedAtSource) {
    let filesystem_timestamp = modified_timestamp(metadata);
    let parsed = fs::read_to_string(note_path)
        .ok()
        .map(|content| parse_frontmatter(&content))
        .unwrap_or_default();

    if let Some(updated_at) = parsed.updated_at {
        return (parsed.tags, updated_at, UpdatedAtSource::Frontmatter);
    }

    (parsed.tags, filesystem_timestamp, UpdatedAtSource::Filesystem)
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

fn trash_root(vault_path: &Path) -> PathBuf {
    vault_path.join(TRASH_DIR_NAME)
}

fn trash_items_directory(vault_path: &Path) -> PathBuf {
    trash_root(vault_path).join(TRASH_ITEMS_DIR_NAME)
}

fn trash_meta_directory(vault_path: &Path) -> PathBuf {
    trash_root(vault_path).join(TRASH_META_DIR_NAME)
}

fn app_directory(vault_path: &Path) -> PathBuf {
    vault_path.join(APP_DIR_NAME)
}

fn legacy_templates_directory(vault_path: &Path) -> PathBuf {
    app_directory(vault_path).join(TEMPLATES_DIR_NAME)
}

fn memories_file_path(vault_path: &Path) -> PathBuf {
    app_directory(vault_path).join(MEMORIES_FILE_NAME)
}

fn ensure_app_layout(vault_path: &Path) -> Result<PathBuf, String> {
    let app_root = app_directory(vault_path);
    fs::create_dir_all(&app_root).map_err(|error| {
        format!(
            "Unable to create app data directory {}: {error}",
            app_root.display()
        )
    })?;
    canonicalize_directory(&app_root)
}

fn global_templates_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))?;
    let templates = app_data_dir.join(TEMPLATES_DIR_NAME);
    fs::create_dir_all(&templates).map_err(|error| {
        format!(
            "Unable to create templates directory {}: {error}",
            templates.display()
        )
    })?;
    canonicalize_directory(&templates)
}

fn migrate_legacy_templates(legacy_templates: &Path, global_templates: &Path) -> Result<(), String> {
    if !legacy_templates.exists() {
        return Ok(());
    }

    let entries = fs::read_dir(legacy_templates).map_err(|error| {
        format!(
            "Unable to read legacy templates directory {}: {error}",
            legacy_templates.display()
        )
    })?;

    let mut existing_templates = Vec::new();
    for entry in fs::read_dir(global_templates).map_err(|error| {
        format!(
            "Unable to read templates directory {}: {error}",
            global_templates.display()
        )
    })? {
        let entry = entry.map_err(|error| format!("Failed to read template entry: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to read template file type: {error}"))?;
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_type.is_file() || !is_markdown_file(file_name) {
            continue;
        }

        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Unable to read template {}: {error}", path.display()))?;
        existing_templates.push((path, content));
    }

    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read legacy template entry: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to read legacy template file type: {error}"))?;
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_type.is_file() || !is_markdown_file(file_name) {
            continue;
        }

        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Unable to read legacy template {}: {error}", path.display()))?;
        if existing_templates
            .iter()
            .any(|(_, existing_content)| existing_content == &content)
        {
            continue;
        }

        let desired_path = global_templates.join(file_name);
        let target_path = if desired_path.exists() {
            find_available_path(&desired_path, true)
        } else {
            desired_path
        };

        fs::write(&target_path, &content).map_err(|error| {
            format!(
                "Unable to migrate legacy template {} to {}: {error}",
                path.display(),
                target_path.display()
            )
        })?;
        existing_templates.push((target_path, content));
    }

    Ok(())
}

fn ensure_templates_layout(
    app: &tauri::AppHandle,
    vault_path: Option<&Path>,
) -> Result<PathBuf, String> {
    let templates = global_templates_directory(app)?;
    if let Some(vault_path) = vault_path {
        migrate_legacy_templates(&legacy_templates_directory(vault_path), &templates)?;
    }
    Ok(templates)
}

fn ensure_template_file_in_store(
    app: &tauri::AppHandle,
    vault_path: Option<&Path>,
    path: &Path,
) -> Result<PathBuf, String> {
    let templates_path = ensure_templates_layout(app, vault_path)?;
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

fn read_json_file_or_default<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Default,
{
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|error| format!("Unable to parse JSON {}: {error}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(format!("Unable to read {}: {error}", path.display())),
    }
}

fn write_string_atomically(path: &Path, content: &str) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "Unable to determine parent directory for {}.",
            path.display()
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create directory {}: {error}", parent.display()))?;

    let temp_path = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("temp")
    ));
    fs::write(&temp_path, content)
        .map_err(|error| format!("Unable to write temporary file {}: {error}", temp_path.display()))?;

    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Unable to replace {}: {error}", path.display()))?;
    }

    fs::rename(&temp_path, path).map_err(|error| {
        format!(
            "Unable to finalize write from {} to {}: {error}",
            temp_path.display(),
            path.display()
        )
    })
}

fn read_memories(vault_path: &Path) -> Result<Vec<Memory>, String> {
    ensure_app_layout(vault_path)?;
    read_json_file_or_default(&memories_file_path(vault_path))
}

fn write_memories(vault_path: &Path, memories: &[Memory]) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(memories)
        .map_err(|error| format!("Unable to serialize memories: {error}"))?;
    write_string_atomically(&memories_file_path(vault_path), &serialized)
}

fn format_memory_date(now: &DateTime<Utc>) -> String {
    format!("{}-{}-{}", now.month(), now.day(), now.year())
}

fn dedupe_auto_memory_title(base_label: &str, date: &str, memories: &[Memory]) -> String {
    let initial = format!("{base_label} ? {date}");
    if memories.iter().all(|memory| memory.title != initial) {
        return initial;
    }

    for suffix in 2..1000 {
        let candidate = format!("{base_label} ({suffix}) ? {date}");
        if memories.iter().all(|memory| memory.title != candidate) {
            return candidate;
        }
    }

    initial
}

fn generate_memory_title(
    title: Option<String>,
    origin_note: Option<&str>,
    memories: &[Memory],
    now: &DateTime<Utc>,
) -> String {
    if let Some(title) = clean_optional_string(title) {
        return title;
    }

    let date = format_memory_date(now);
    let base_label = origin_note.unwrap_or("Memory");
    dedupe_auto_memory_title(base_label, &date, memories)
}

fn build_memory(
    title: Option<String>,
    content: String,
    origin_note: Option<String>,
    memories: &[Memory],
    now: DateTime<Utc>,
) -> Memory {
    let origin_note = clean_optional_string(origin_note);
    Memory {
        id: Uuid::new_v4().to_string(),
        title: generate_memory_title(title, origin_note.as_deref(), memories, &now),
        content,
        origin_note,
        created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
    }
}

fn update_memory_fields(
    memories: &mut [Memory],
    id: &str,
    title: Option<String>,
    content: Option<String>,
) -> Result<Memory, String> {
    let memory = memories
        .iter_mut()
        .find(|memory| memory.id == id)
        .ok_or_else(|| format!("No memory found for id {id}."))?;

    if let Some(title) = title {
        memory.title = title;
    }
    if let Some(content) = content {
        memory.content = content;
    }

    Ok(memory.clone())
}

fn delete_memory_by_id(memories: &mut Vec<Memory>, id: &str) -> Result<DeleteMemoryResult, String> {
    let position = memories
        .iter()
        .position(|memory| memory.id == id)
        .ok_or_else(|| format!("No memory found for id {id}."))?;
    memories.remove(position);
    Ok(DeleteMemoryResult {
        success: true,
        id: id.to_string(),
    })
}

fn note_metadata_sidecar_path(note_path: &Path) -> Result<PathBuf, String> {
    let file_name = note_path.file_name().ok_or_else(|| {
        format!(
            "Unable to determine note filename for metadata at {}.",
            note_path.display()
        )
    })?;

    Ok(note_path.parent().unwrap_or_else(|| Path::new(".")).join(format!(
        "{}.gravity.json",
        file_name.to_string_lossy()
    )))
}

fn move_note_sidecar(old_note_path: &Path, new_note_path: &Path) -> Result<(), String> {
    let old_sidecar = note_metadata_sidecar_path(old_note_path)?;
    if !old_sidecar.exists() {
        return Ok(());
    }

    let new_sidecar = note_metadata_sidecar_path(new_note_path)?;
    fs::rename(&old_sidecar, &new_sidecar).map_err(|error| {
        format!(
            "Unable to move note metadata {} to {}: {error}",
            old_sidecar.display(),
            new_sidecar.display()
        )
    })
}

fn is_inside_trash(vault_path: &Path, path: &Path) -> bool {
    path.starts_with(trash_root(vault_path))
}

fn is_inside_app_directory(vault_path: &Path, path: &Path) -> bool {
    path.starts_with(app_directory(vault_path))
}

fn ensure_directory_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = canonicalize_directory(path)?;
    if !canonical.starts_with(vault_path) {
        return Err(String::from("Requested folder is outside the selected vault."));
    }
    if is_inside_trash(vault_path, &canonical) {
        return Err(String::from("Requested folder is inside the app-managed trash."));
    }
    if is_inside_app_directory(vault_path, &canonical) {
        return Err(String::from(
            "Requested folder is inside the app-managed data directory.",
        ));
    }
    Ok(canonical)
}

fn ensure_file_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access file {}: {error}", path.display()))?;
    if !canonical.starts_with(vault_path) {
        return Err(String::from("Requested file is outside the selected vault."));
    }
    if is_inside_trash(vault_path, &canonical) {
        return Err(String::from("Requested file is inside the app-managed trash."));
    }
    if is_inside_app_directory(vault_path, &canonical) {
        return Err(String::from(
            "Requested file is inside the app-managed data directory.",
        ));
    }
    if !canonical.is_file() {
        return Err(format!("Path is not a file: {}", canonical.display()));
    }
    Ok(canonical)
}

fn ensure_trash_layout(vault_path: &Path) -> Result<(), String> {
    let trash_items = trash_items_directory(vault_path);
    fs::create_dir_all(&trash_items)
        .map_err(|error| format!("Unable to create trash directory {}: {error}", trash_items.display()))?;

    let trash_meta = trash_meta_directory(vault_path);
    fs::create_dir_all(&trash_meta).map_err(|error| {
        format!(
            "Unable to create trash metadata directory {}: {error}",
            trash_meta.display()
        )
    })?;

    Ok(())
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

fn file_title_from_path(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| String::from("untitled"))
}

fn note_file_name(title: &str) -> String {
    let slug = slugify(title);
    format!("{}.md", if slug.is_empty() { "untitled" } else { slug.as_str() })
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

fn folder_name(name: &str) -> String {
    let slug = slugify(name);
    if slug.is_empty() {
        String::from("new-folder")
    } else {
        slug
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
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
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

fn metadata_updated_at(path: &Path) -> Result<u64, String> {
    let modified = fs::metadata(path)
        .map_err(|error| format!("Unable to read metadata for {}: {error}", path.display()))?
        .modified()
        .map_err(|error| format!("Unable to read modified time for {}: {error}", path.display()))?;
    let duration = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Invalid modified time for {}: {error}", path.display()))?;
    u64::try_from(duration.as_millis())
        .map_err(|_| format!("Modified time is out of range for {}", path.display()))
}

fn build_note(path: &Path) -> Result<Note, String> {
    let path_string = path_to_string(path);
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Unable to read file metadata for {}: {error}", path.display()))?;
    let (tags, updated_at, updated_at_source) = build_note_metadata(path, &metadata);

    Ok(Note {
        id: path_string.clone(),
        title: file_title_from_path(path),
        path: path_string,
        tags,
        updated_at,
        updated_at_source,
    })
}

fn build_folder_item(vault_path: &Path, path: &Path) -> Result<FolderItem, String> {
    Ok(FolderItem {
        id: path_to_string(path),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| String::from("folder")),
        path: path_to_string(path),
        item_type: "folder",
        children: list_directory_entries(vault_path, path)?,
    })
}

fn build_template_summary(path: &Path) -> Result<TemplateSummary, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid template file name: {}", path.display()))?;
    let path_string = path_to_string(path);
    Ok(TemplateSummary {
        id: path_string.clone(),
        name: strip_markdown_extension(file_name).to_string(),
        path: path_string,
        updated_at: metadata_updated_at(path)?,
    })
}

fn build_template_content(path: &Path) -> Result<TemplateContent, String> {
    let summary = build_template_summary(path)?;
    let parsed = parse_template_markdown(
        &fs::read_to_string(path)
            .map_err(|error| format!("Unable to read template {}: {error}", path.display()))?,
    );

    Ok(TemplateContent {
        id: summary.id,
        name: summary.name,
        path: summary.path,
        updated_at: summary.updated_at,
        body: parsed.body,
        subject: parsed.subject,
        tags: parsed.tags,
    })
}

fn build_template_item(path: &Path) -> Result<TemplateItem, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read template {}: {error}", path.display()))?;
    let path_string = path_to_string(path);

    Ok(TemplateItem {
        id: path_string.clone(),
        name: file_title_from_path(path),
        path: path_string,
        content,
    })
}

fn sort_templates(items: &mut [TemplateSummary]) {
    items.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
    });
}

fn sort_items(items: &mut [FileSystemItem]) {
    items.sort_by(|left, right| match (left, right) {
        (FileSystemItem::Folder { name: a, .. }, FileSystemItem::Folder { name: b, .. }) => {
            a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase())
        }
        (FileSystemItem::File { title: a, .. }, FileSystemItem::File { title: b, .. }) => {
            a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase())
        }
        (FileSystemItem::Folder { .. }, FileSystemItem::File { .. }) => std::cmp::Ordering::Less,
        (FileSystemItem::File { .. }, FileSystemItem::Folder { .. }) => {
            std::cmp::Ordering::Greater
        }
    });
}

fn list_directory_entries(vault_path: &Path, directory: &Path) -> Result<Vec<FileSystemItem>, String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Unable to read directory {}: {error}", directory.display()))?;

    let trash_root_path = trash_root(vault_path);
    let app_root_path = app_directory(vault_path);
    let mut items = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let entry_path = entry.path();
        if entry_path == trash_root_path || entry_path == app_root_path {
            continue;
        }

        let entry_name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to read file type for {}: {error}", entry_name))?;

        if file_type.is_dir() {
            let mut children = list_directory_entries(vault_path, &entry_path)?;
            sort_items(&mut children);
            items.push(FileSystemItem::Folder {
                id: path_to_string(&entry_path),
                name: entry_name,
                path: path_to_string(&entry_path),
                children,
            });
        } else if file_type.is_file() && is_markdown_file(&entry_name) {
            let metadata = entry
                .metadata()
                .map_err(|error| format!("Failed to read metadata for {}: {error}", entry_name))?;
            let (tags, updated_at, updated_at_source) =
                build_note_metadata(&entry_path, &metadata);
            items.push(FileSystemItem::File {
                id: path_to_string(&entry_path),
                title: strip_markdown_extension(&entry_name).to_string(),
                path: path_to_string(&entry_path),
                tags,
                updated_at,
                updated_at_source,
            });
        }
    }

    sort_items(&mut items);
    Ok(items)
}

fn resolve_target_directory(vault_path: &Path, folder_path: Option<String>) -> Result<PathBuf, String> {
    if let Some(path) = folder_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return ensure_directory_in_vault(vault_path, Path::new(trimmed));
        }
    }
    Ok(vault_path.to_path_buf())
}

fn find_available_path(desired_path: &Path, is_file: bool) -> PathBuf {
    if !desired_path.exists() {
        return desired_path.to_path_buf();
    }

    let parent = desired_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let base_name = if is_file {
        desired_path
            .file_stem()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| String::from("untitled"))
    } else {
        desired_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| String::from("folder"))
    };

    let extension = if is_file {
        desired_path
            .extension()
            .map(|value| value.to_string_lossy().into_owned())
    } else {
        None
    };

    for suffix in 1..1000 {
        let candidate_name = match &extension {
            Some(extension) => format!("{base_name}-{suffix}.{extension}"),
            None => format!("{base_name}-{suffix}"),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    desired_path.to_path_buf()
}

fn ensure_can_manage_folder(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let folder_path = ensure_directory_in_vault(vault_path, path)?;
    if folder_path == vault_path {
        return Err(String::from("The vault root cannot be renamed, moved, or deleted."));
    }
    Ok(folder_path)
}

fn relative_to_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    path.strip_prefix(vault_path)
        .map(Path::to_path_buf)
        .map_err(|_| format!("Path {} is outside the selected vault.", path.display()))
}

fn metadata_path(vault_path: &Path, id: &str) -> PathBuf {
    trash_meta_directory(vault_path).join(format!("{id}.json"))
}

fn stored_trash_path(vault_path: &Path, id: &str) -> PathBuf {
    trash_items_directory(vault_path).join(id)
}

fn generate_trash_id(vault_path: &Path, name: &str) -> Result<String, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| String::from("System clock is before Unix epoch."))?
        .as_millis();

    let slug = {
        let slug = slugify(name);
        if slug.is_empty() {
            String::from("item")
        } else {
            slug
        }
    };

    for counter in 0..1000 {
        let candidate = if counter == 0 {
            format!("{timestamp}-{slug}")
        } else {
            format!("{timestamp}-{slug}-{counter}")
        };
        if !metadata_path(vault_path, &candidate).exists() && !stored_trash_path(vault_path, &candidate).exists() {
            return Ok(candidate);
        }
    }

    Err(String::from("Unable to generate a unique trash identifier."))
}

fn write_trash_metadata(vault_path: &Path, metadata: &TrashMetadata) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(metadata)
        .map_err(|error| format!("Unable to serialize trash metadata: {error}"))?;
    let destination = metadata_path(vault_path, &metadata.id);
    fs::write(&destination, serialized)
        .map_err(|error| format!("Unable to write trash metadata {}: {error}", destination.display()))
}

fn read_trash_metadata(vault_path: &Path, id: &str) -> Result<TrashMetadata, String> {
    let source = metadata_path(vault_path, id);
    let content = fs::read_to_string(&source)
        .map_err(|error| format!("Unable to read trash metadata {}: {error}", source.display()))?;
    serde_json::from_str(&content).map_err(|error| format!("Unable to parse trash metadata for {id}: {error}"))
}

fn move_path_to_trash(vault_path: &Path, source_path: &Path, item_type: TrashItemType) -> Result<(), String> {
    ensure_trash_layout(vault_path)?;

    let name = source_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| String::from("item"));
    let trash_id = generate_trash_id(vault_path, &name)?;
    let destination = stored_trash_path(vault_path, &trash_id);
    let deleted_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| String::from("System clock is before Unix epoch."))?
        .as_millis();

    fs::rename(source_path, &destination).map_err(|error| {
        format!(
            "Unable to move {} to trash at {}: {error}",
            source_path.display(),
            destination.display()
        )
    })?;

    let metadata = TrashMetadata {
        id: trash_id,
        name,
        original_relative_path: path_to_string(&relative_to_vault(vault_path, source_path)?),
        item_type,
        deleted_at,
    };

    if let Err(error) = write_trash_metadata(vault_path, &metadata) {
        let _ = fs::rename(&destination, source_path);
        return Err(error);
    }

    Ok(())
}

fn list_trash(vault_path: &Path) -> Result<Vec<TrashEntry>, String> {
    ensure_trash_layout(vault_path)?;
    let entries = fs::read_dir(trash_meta_directory(vault_path)).map_err(|error| {
        format!(
            "Unable to read trash metadata directory {}: {error}",
            trash_meta_directory(vault_path).display()
        )
    })?;

    let mut trash_entries = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read trash metadata entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }

        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Unable to read trash metadata {}: {error}", path.display()))?;
        let metadata: TrashMetadata = serde_json::from_str(&content)
            .map_err(|error| format!("Unable to parse trash metadata {}: {error}", path.display()))?;

        trash_entries.push(TrashEntry {
            id: metadata.id,
            name: metadata.name,
            original_path: path_to_string(&vault_path.join(metadata.original_relative_path)),
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

fn restore_trash_item(vault_path: &Path, id: &str) -> Result<(), String> {
    let metadata = read_trash_metadata(vault_path, id)?;
    let source = stored_trash_path(vault_path, id);
    let desired = vault_path.join(&metadata.original_relative_path);
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
    fs::remove_file(metadata_path(vault_path, id)).map_err(|error| {
        format!(
            "Unable to remove trash metadata {}: {error}",
            metadata_path(vault_path, id).display()
        )
    })?;

    Ok(())
}

fn permanently_delete_trash_item(vault_path: &Path, id: &str) -> Result<(), String> {
    let metadata = read_trash_metadata(vault_path, id)?;
    let source = stored_trash_path(vault_path, id);

    match metadata.item_type {
        TrashItemType::File => fs::remove_file(&source)
            .map_err(|error| format!("Unable to delete trashed file {}: {error}", source.display()))?,
        TrashItemType::Folder => fs::remove_dir_all(&source)
            .map_err(|error| format!("Unable to delete trashed folder {}: {error}", source.display()))?,
    }

    fs::remove_file(metadata_path(vault_path, id)).map_err(|error| {
        format!(
            "Unable to remove trash metadata {}: {error}",
            metadata_path(vault_path, id).display()
        )
    })?;

    Ok(())
}

#[tauri::command]
fn set_vault_path(path: String, state: tauri::State<VaultState>) -> Result<String, String> {
    let canonical = canonicalize_directory(Path::new(&path))?;
    ensure_trash_layout(&canonical)?;
    let mut guard = state
        .selected_path
        .lock()
        .map_err(|_| String::from("Vault state lock poisoned"))?;
    *guard = Some(canonical.clone());
    Ok(path_to_string(&canonical))
}

#[tauri::command]
fn list_vault_entries(state: tauri::State<VaultState>) -> Result<Vec<FileSystemItem>, String> {
    let vault_path = get_selected_vault(&state)?;
    list_directory_entries(&vault_path, &vault_path)
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
    initial_content: String,
    state: tauri::State<VaultState>,
) -> Result<Note, String> {
    let vault_path = get_selected_vault(&state)?;
    let target_directory = resolve_target_directory(&vault_path, folder_path)?;
    let desired_path = target_directory.join(note_file_name(title.trim()));
    let note_path = find_available_path(&desired_path, true);
    fs::write(&note_path, normalize_markdown(&initial_content))
        .map_err(|error| format!("Unable to create note at {}: {error}", note_path.display()))?;
    build_note(&note_path)
}

#[tauri::command]
fn rename_note(path: String, title: String, state: tauri::State<VaultState>) -> Result<Note, String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
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
    if next_path == note_path {
        return build_note(&note_path);
    }
    fs::rename(&note_path, &next_path).map_err(|error| {
        format!(
            "Unable to rename note {} to {}: {error}",
            note_path.display(),
            next_path.display()
        )
    })?;
    move_note_sidecar(&note_path, &next_path)?;
    build_note(&next_path)
}

#[tauri::command]
fn move_note(path: String, folder_path: Option<String>, state: tauri::State<VaultState>) -> Result<Note, String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
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
    if next_path == note_path {
        return build_note(&note_path);
    }
    fs::rename(&note_path, &next_path).map_err(|error| {
        format!(
            "Unable to move note {} to {}: {error}",
            note_path.display(),
            next_path.display()
        )
    })?;
    move_note_sidecar(&note_path, &next_path)?;
    build_note(&next_path)
}

#[tauri::command]
fn create_folder(name: String, folder_path: Option<String>, state: tauri::State<VaultState>) -> Result<FolderItem, String> {
    let vault_path = get_selected_vault(&state)?;
    let target_directory = resolve_target_directory(&vault_path, folder_path)?;
    let desired_path = target_directory.join(folder_name(name.trim()));
    let folder_path = find_available_path(&desired_path, false);
    fs::create_dir_all(&folder_path)
        .map_err(|error| format!("Unable to create folder at {}: {error}", folder_path.display()))?;
    build_folder_item(&vault_path, &folder_path)
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
    if next_path == folder_path {
        return build_folder_item(&vault_path, &folder_path);
    }
    fs::rename(&folder_path, &next_path).map_err(|error| {
        format!(
            "Unable to rename folder {} to {}: {error}",
            folder_path.display(),
            next_path.display()
        )
    })?;
    build_folder_item(&vault_path, &next_path)
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
    if next_path == source_path {
        return build_folder_item(&vault_path, &source_path);
    }
    fs::rename(&source_path, &next_path).map_err(|error| {
        format!(
            "Unable to move folder {} to {}: {error}",
            source_path.display(),
            next_path.display()
        )
    })?;
    build_folder_item(&vault_path, &next_path)
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
    fs::write(&note_path, content)
        .map_err(|error| format!("Unable to write note at {}: {error}", note_path.display()))
}

#[tauri::command]
fn read_note_metadata(path: String, state: tauri::State<VaultState>) -> Result<Value, String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    let sidecar_path = note_metadata_sidecar_path(&note_path)?;
    if !sidecar_path.exists() {
        return Ok(Value::Object(Default::default()));
    }

    let content = fs::read_to_string(&sidecar_path)
        .map_err(|error| format!("Unable to read note metadata {}: {error}", sidecar_path.display()))?;
    let metadata: Value = serde_json::from_str(&content)
        .map_err(|error| format!("Unable to parse note metadata {}: {error}", sidecar_path.display()))?;
    if !metadata.is_object() {
        return Err(String::from("Note metadata must be a JSON object."));
    }
    Ok(metadata)
}

#[tauri::command]
fn write_note_metadata(path: String, metadata: Value, state: tauri::State<VaultState>) -> Result<Value, String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    if !metadata.is_object() {
        return Err(String::from("Note metadata must be a JSON object."));
    }

    let sidecar_path = note_metadata_sidecar_path(&note_path)?;
    if metadata.as_object().is_some_and(|value| value.is_empty()) {
        if sidecar_path.exists() {
            fs::remove_file(&sidecar_path)
                .map_err(|error| format!("Unable to remove note metadata {}: {error}", sidecar_path.display()))?;
        }
        return Ok(metadata);
    }

    let serialized = serde_json::to_string_pretty(&metadata)
        .map_err(|error| format!("Unable to serialize note metadata: {error}"))?;
    fs::write(&sidecar_path, serialized)
        .map_err(|error| format!("Unable to write note metadata {}: {error}", sidecar_path.display()))?;
    Ok(metadata)
}

#[tauri::command]
fn create_memory(
    title: Option<String>,
    content: String,
    origin_note: Option<String>,
    state: tauri::State<VaultState>,
) -> Result<Memory, String> {
    let vault_path = get_selected_vault(&state)?;
    let mut memories = read_memories(&vault_path)?;
    let memory = build_memory(title, content, origin_note, &memories, Utc::now());
    memories.push(memory.clone());
    write_memories(&vault_path, &memories)?;
    Ok(memory)
}

#[tauri::command]
fn list_memories(state: tauri::State<VaultState>) -> Result<Vec<Memory>, String> {
    let vault_path = get_selected_vault(&state)?;
    read_memories(&vault_path)
}

#[tauri::command]
fn update_memory(
    id: String,
    title: Option<String>,
    content: Option<String>,
    state: tauri::State<VaultState>,
) -> Result<Memory, String> {
    let vault_path = get_selected_vault(&state)?;
    let mut memories = read_memories(&vault_path)?;
    let updated = update_memory_fields(&mut memories, id.trim(), title, content)?;
    write_memories(&vault_path, &memories)?;
    Ok(updated)
}

#[tauri::command]
fn delete_memory(id: String, state: tauri::State<VaultState>) -> Result<DeleteMemoryResult, String> {
    let vault_path = get_selected_vault(&state)?;
    let trimmed_id = id.trim().to_string();
    let mut memories = read_memories(&vault_path)?;
    let result = delete_memory_by_id(&mut memories, &trimmed_id)?;
    write_memories(&vault_path, &memories)?;
    Ok(result)
}

#[tauri::command]
fn list_templates(app: tauri::AppHandle, state: tauri::State<VaultState>) -> Result<Vec<TemplateSummary>, String> {
    let vault_path = get_selected_vault(&state)?;
    let templates_path = ensure_templates_layout(&app, Some(&vault_path))?;
    let entries = fs::read_dir(&templates_path).map_err(|error| {
        format!(
            "Unable to read templates directory {}: {error}",
            templates_path.display()
        )
    })?;

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
    app: tauri::AppHandle,
    state: tauri::State<VaultState>,
) -> Result<TemplateContent, String> {
    let vault_path = get_selected_vault(&state)?;
    let templates_path = ensure_templates_layout(&app, Some(&vault_path))?;
    let desired_path = templates_path.join(format!("{}.md", sanitize_template_name(name.trim())));
    let template_path = find_available_path(&desired_path, true);
    let markdown = serialize_template_markdown(&ParsedTemplateSeed {
        body: normalize_markdown(&body),
        subject,
        tags,
    });
    fs::write(&template_path, markdown)
        .map_err(|error| format!("Unable to create template at {}: {error}", template_path.display()))?;
    build_template_content(&template_path)
}

#[tauri::command]
fn read_template(path: String, app: tauri::AppHandle, state: tauri::State<VaultState>) -> Result<TemplateContent, String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file_in_store(&app, Some(&vault_path), Path::new(path.trim()))?;
    build_template_content(&template_path)
}

#[tauri::command]
fn rename_template(path: String, new_name: String, app: tauri::AppHandle, state: tauri::State<VaultState>) -> Result<TemplateSummary, String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file_in_store(&app, Some(&vault_path), Path::new(path.trim()))?;
    let templates_path = ensure_templates_layout(&app, Some(&vault_path))?;
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

    build_template_summary(&next_path)
}

#[tauri::command]
fn update_template(
    path: String,
    name: Option<String>,
    content: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<VaultState>,
) -> Result<TemplateItem, String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file_in_store(&app, Some(&vault_path), Path::new(path.trim()))?;
    let next_path = if let Some(next_name) = name {
        let templates_path = ensure_templates_layout(&app, Some(&vault_path))?;
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
        fs::write(&next_path, next_content)
            .map_err(|error| format!("Unable to update template {}: {error}", next_path.display()))?;
    }

    build_template_item(&next_path)
}

#[tauri::command]
fn delete_template(path: String, app: tauri::AppHandle, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file_in_store(&app, Some(&vault_path), Path::new(path.trim()))?;
    fs::remove_file(&template_path)
        .map_err(|error| format!("Unable to delete template {}: {error}", template_path.display()))
}

#[tauri::command]
fn apply_template(
    template_path: String,
    note_path: String,
    mode: TemplateApplyMode,
    app: tauri::AppHandle,
    state: tauri::State<VaultState>,
) -> Result<String, String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file_in_store(&app, Some(&vault_path), Path::new(template_path.trim()))?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(note_path.trim()))?;
    let template_content = fs::read_to_string(&template_path)
        .map_err(|error| format!("Unable to read template {}: {error}", template_path.display()))?;
    let existing_content = fs::read_to_string(&note_path)
        .map_err(|error| format!("Unable to read note {}: {error}", note_path.display()))?;

    let next_content = match mode {
        TemplateApplyMode::Replace => template_content,
        TemplateApplyMode::Prepend => format!("{template_content}{existing_content}"),
        TemplateApplyMode::Append => format!("{existing_content}{template_content}"),
    };

    fs::write(&note_path, &next_content)
        .map_err(|error| format!("Unable to apply template to {}: {error}", note_path.display()))?;
    Ok(next_content)
}

#[tauri::command]
fn delete_note(path: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    move_path_to_trash(&vault_path, &note_path, TrashItemType::File)
}

#[tauri::command]
fn delete_folder(path: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let folder_path = ensure_can_manage_folder(&vault_path, Path::new(path.trim()))?;
    move_path_to_trash(&vault_path, &folder_path, TrashItemType::Folder)
}

#[tauri::command]
fn restore_trash_entry(id: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    restore_trash_item(&vault_path, id.trim())
}

#[tauri::command]
fn permanently_delete_trash_entry(id: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    permanently_delete_trash_item(&vault_path, id.trim())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let path = env::temp_dir().join(format!("gravity-tests-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create test dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn fixed_time() -> DateTime<Utc> {
        let date_time = NaiveDate::from_ymd_opt(2025, 1, 14)
            .unwrap()
            .and_hms_milli_opt(10, 23, 0, 0)
            .unwrap();
        Utc.from_utc_datetime(&date_time)
    }

    fn sample_memory(title: &str) -> Memory {
        Memory {
            id: Uuid::new_v4().to_string(),
            title: title.to_string(),
            content: String::from("content"),
            origin_note: Some(String::from("Note")),
            created_at: String::from("2025-01-14T10:23:00.000Z"),
        }
    }

    #[test]
    fn read_memories_returns_empty_when_missing() {
        let dir = TestDir::new();
        let memories = read_memories(dir.path()).expect("read memories");
        assert!(memories.is_empty());
    }

    #[test]
    fn read_memories_errors_on_malformed_json() {
        let dir = TestDir::new();
        fs::create_dir_all(app_directory(dir.path())).expect("create app dir");
        fs::write(memories_file_path(dir.path()), "{not-json}").expect("write malformed json");

        let error = read_memories(dir.path()).expect_err("expected parse error");
        assert!(error.contains("Unable to parse JSON"));
    }

    #[test]
    fn build_memory_generates_uuid_and_iso_timestamp() {
        let memory = build_memory(
            None,
            String::from("content"),
            Some(String::from("Meeting Notes")),
            &[],
            fixed_time(),
        );

        Uuid::parse_str(&memory.id).expect("uuid");
        assert_eq!(memory.title, "Meeting Notes ? 1-14-2025");
        assert_eq!(memory.created_at, "2025-01-14T10:23:00.000Z");
        assert_eq!(memory.origin_note.as_deref(), Some("Meeting Notes"));
    }

    #[test]
    fn build_memory_uses_manual_title_without_rewriting() {
        let memory = build_memory(
            Some(String::from("Custom Title")),
            String::from("content"),
            Some(String::from("Meeting Notes")),
            &[sample_memory("Custom Title")],
            fixed_time(),
        );

        assert_eq!(memory.title, "Custom Title");
    }

    #[test]
    fn build_memory_generates_manual_memory_title() {
        let memory = build_memory(None, String::from("content"), None, &[], fixed_time());
        assert_eq!(memory.title, "Memory ? 1-14-2025");
        assert_eq!(memory.origin_note, None);
    }

    #[test]
    fn build_memory_dedupes_auto_titles() {
        let memories = vec![
            sample_memory("Meeting Notes ? 1-14-2025"),
            sample_memory("Meeting Notes (2) ? 1-14-2025"),
        ];

        let memory = build_memory(
            None,
            String::from("content"),
            Some(String::from("Meeting Notes")),
            &memories,
            fixed_time(),
        );

        assert_eq!(memory.title, "Meeting Notes (3) ? 1-14-2025");
    }

    #[test]
    fn update_memory_changes_only_provided_fields() {
        let original = Memory {
            id: String::from("abc"),
            title: String::from("Original"),
            content: String::from("Before"),
            origin_note: Some(String::from("Source")),
            created_at: String::from("2025-01-14T10:23:00.000Z"),
        };
        let mut memories = vec![original.clone()];

        let updated = update_memory_fields(
            &mut memories,
            "abc",
            Some(String::from("Updated")),
            None,
        )
        .expect("update memory");

        assert_eq!(updated.title, "Updated");
        assert_eq!(updated.content, "Before");
        assert_eq!(updated.origin_note, original.origin_note);
        assert_eq!(updated.created_at, original.created_at);
    }

    #[test]
    fn update_memory_rejects_missing_id() {
        let mut memories = vec![sample_memory("Memory")];
        let error = update_memory_fields(&mut memories, "missing", None, None)
            .expect_err("expected missing memory error");
        assert!(error.contains("No memory found"));
    }

    #[test]
    fn delete_memory_returns_success_and_removes_item() {
        let mut memories = vec![sample_memory("Memory")];
        let id = memories[0].id.clone();

        let result = delete_memory_by_id(&mut memories, &id).expect("delete memory");

        assert_eq!(result, DeleteMemoryResult { success: true, id });
        assert!(memories.is_empty());
    }

    #[test]
    fn delete_memory_rejects_missing_id() {
        let mut memories = vec![sample_memory("Memory")];
        let error = delete_memory_by_id(&mut memories, "missing")
            .expect_err("expected missing memory error");
        assert!(error.contains("No memory found"));
    }

    #[test]
    fn write_memories_round_trip_and_replaces_previous_file() {
        let dir = TestDir::new();
        let first = vec![sample_memory("One")];
        let second = vec![sample_memory("Two")];

        write_memories(dir.path(), &first).expect("write first memories");
        write_memories(dir.path(), &second).expect("write second memories");

        let loaded = read_memories(dir.path()).expect("read memories");
        assert_eq!(loaded, second);
        assert!(!app_directory(dir.path()).join(".memories.json.tmp").exists());
    }

    #[test]
    fn migrate_legacy_templates_copies_templates_to_global_store() {
        let dir = TestDir::new();
        let legacy = legacy_templates_directory(dir.path());
        let global = dir.path().join("global-templates");
        fs::create_dir_all(&legacy).expect("create legacy dir");
        fs::create_dir_all(&global).expect("create global dir");
        fs::write(legacy.join("starter.md"), "legacy template").expect("write legacy template");

        migrate_legacy_templates(&legacy, &global).expect("migrate templates");

        assert_eq!(
            fs::read_to_string(global.join("starter.md")).expect("read migrated template"),
            "legacy template"
        );
    }

    #[test]
    fn migrate_legacy_templates_is_idempotent() {
        let dir = TestDir::new();
        let legacy = legacy_templates_directory(dir.path());
        let global = dir.path().join("global-templates");
        fs::create_dir_all(&legacy).expect("create legacy dir");
        fs::create_dir_all(&global).expect("create global dir");
        fs::write(legacy.join("starter.md"), "legacy template").expect("write legacy template");

        migrate_legacy_templates(&legacy, &global).expect("first migration");
        migrate_legacy_templates(&legacy, &global).expect("second migration");

        let files = fs::read_dir(&global)
            .expect("read global dir")
            .filter_map(Result::ok)
            .count();
        assert_eq!(files, 1);
    }

    #[test]
    fn migrate_legacy_templates_keeps_global_template_as_source_of_truth() {
        let dir = TestDir::new();
        let legacy = legacy_templates_directory(dir.path());
        let global = dir.path().join("global-templates");
        fs::create_dir_all(&legacy).expect("create legacy dir");
        fs::create_dir_all(&global).expect("create global dir");
        fs::write(legacy.join("starter.md"), "legacy template").expect("write legacy template");
        fs::write(global.join("starter.md"), "global template").expect("write global template");

        migrate_legacy_templates(&legacy, &global).expect("migrate templates");

        assert_eq!(
            fs::read_to_string(global.join("starter.md")).expect("read global template"),
            "global template"
        );
        assert_eq!(
            fs::read_to_string(global.join("starter-1.md")).expect("read migrated duplicate"),
            "legacy template"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(VaultState::default())
        .invoke_handler(tauri::generate_handler![
            set_vault_path,
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
            delete_note,
            delete_folder,
            restore_trash_entry,
            permanently_delete_trash_entry,
            create_memory,
            list_memories,
            update_memory,
            delete_memory,
            list_templates,
            create_template,
            read_template,
            rename_template,
            update_template,
            delete_template,
            apply_template
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

















