use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const TRASH_DIRECTORY_NAME: &str = ".gravity-trash";
const TRASH_ITEMS_DIRECTORY: &str = "items";
const TRASH_INDEX_FILE: &str = "index.json";

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

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
enum TrashItemType {
    #[serde(rename = "note")]
    Note,
    #[serde(rename = "folder")]
    Folder,
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashRecord {
    original_path: String,
    trash_path: String,
    item_type: TrashItemType,
    deleted_at: i64,
}

#[derive(Default)]
struct ParsedFrontmatter {
    updated_at: Option<i64>,
    tags: Vec<String>,
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn current_timestamp_ms() -> i64 {
    timestamp_from_system_time(SystemTime::now())
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
    vault_path.join(TRASH_DIRECTORY_NAME)
}

fn trash_items_root(vault_path: &Path) -> PathBuf {
    trash_root(vault_path).join(TRASH_ITEMS_DIRECTORY)
}

fn trash_index_path(vault_path: &Path) -> PathBuf {
    trash_root(vault_path).join(TRASH_INDEX_FILE)
}

fn ensure_path_inside_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access path {}: {error}", path.display()))?;
    if !canonical.starts_with(vault_path) {
        return Err(String::from("Requested path is outside the selected vault."));
    }
    Ok(canonical)
}

fn ensure_live_path_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = ensure_path_inside_vault(vault_path, path)?;
    if canonical.starts_with(trash_root(vault_path)) {
        return Err(String::from("Requested path is inside the trash area."));
    }
    Ok(canonical)
}

fn ensure_directory_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = canonicalize_directory(path)?;
    if !canonical.starts_with(vault_path) {
        return Err(String::from("Requested folder is outside the selected vault."));
    }
    if canonical.starts_with(trash_root(vault_path)) {
        return Err(String::from("Requested folder is inside the trash area."));
    }
    Ok(canonical)
}

fn ensure_file_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = ensure_live_path_in_vault(vault_path, path)?;
    if !canonical.is_file() {
        return Err(format!("Path is not a file: {}", canonical.display()));
    }
    Ok(canonical)
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

fn parse_inline_tags(value: &str, tags: &mut Vec<String>) {
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

        if let Some(value) = line.strip_prefix("updated:") {
            frontmatter.updated_at = parse_frontmatter_timestamp(value);
            current_key = None;
            continue;
        }

        if let Some(value) = line.strip_prefix("tags:") {
            let trimmed_value = value.trim();
            if trimmed_value.is_empty() {
                current_key = Some("tags");
            } else {
                parse_inline_tags(trimmed_value, &mut frontmatter.tags);
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

fn list_directory_entries(directory: &Path) -> Result<Vec<FileSystemItem>, String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Unable to read directory {}: {error}", directory.display()))?;

    let mut items = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let entry_path = entry.path();
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        if entry_name == TRASH_DIRECTORY_NAME {
            continue;
        }

        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to read file type for {}: {error}", entry_name))?;

        if file_type.is_dir() {
            let mut children = list_directory_entries(&entry_path)?;
            sort_items(&mut children);
            items.push(FileSystemItem::Folder {
                id: path_to_string(&entry_path),
                name: entry_name,
                path: path_to_string(&entry_path),
                children,
            });
        } else if file_type.is_file() && entry_name.to_ascii_lowercase().ends_with(".md") {
            let title = entry_name
                .strip_suffix(".md")
                .or_else(|| entry_name.strip_suffix(".MD"))
                .unwrap_or(&entry_name)
                .to_string();
            let metadata = entry
                .metadata()
                .map_err(|error| format!("Unable to read file metadata for {}: {error}", entry_name))?;
            let (tags, updated_at, updated_at_source) = build_note_metadata(&entry_path, &metadata);
            items.push(FileSystemItem::File {
                id: path_to_string(&entry_path),
                title,
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

fn resolve_target_directory(
    vault_path: &Path,
    folder_path: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(path) = folder_path {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return ensure_directory_in_vault(vault_path, Path::new(trimmed));
        }
    }
    Ok(vault_path.to_path_buf())
}

fn build_conflict_path(target: &Path, suffix: usize, is_file: bool) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", target.display()))?;

    if is_file {
        let stem = target
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("untitled");
        let extension = target.extension().and_then(|value| value.to_str()).unwrap_or("");
        let file_name = if extension.is_empty() {
            format!("{stem}-{suffix}")
        } else {
            format!("{stem}-{suffix}.{extension}")
        };
        return Ok(parent.join(file_name));
    }

    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("item");
    Ok(parent.join(format!("{name}-{suffix}")))
}

fn ensure_unique_path(target: &Path, is_file: bool) -> Result<PathBuf, String> {
    if !target.exists() {
        return Ok(target.to_path_buf());
    }

    for suffix in 1..1000 {
        let candidate = build_conflict_path(target, suffix, is_file)?;
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!("Unable to find an available path for {}", target.display()))
}

fn load_trash_index(vault_path: &Path) -> Result<Vec<TrashRecord>, String> {
    let index_path = trash_index_path(vault_path);
    if !index_path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(&index_path)
        .map_err(|error| format!("Unable to read trash index at {}: {error}", index_path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("Unable to parse trash index at {}: {error}", index_path.display()))
}

fn save_trash_index(vault_path: &Path, records: &[TrashRecord]) -> Result<(), String> {
    let root = trash_root(vault_path);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Unable to prepare trash folder at {}: {error}", root.display()))?;

    let index_path = trash_index_path(vault_path);
    let serialized = serde_json::to_string_pretty(records)
        .map_err(|error| format!("Unable to serialize trash index: {error}"))?;
    fs::write(&index_path, serialized)
        .map_err(|error| format!("Unable to write trash index at {}: {error}", index_path.display()))
}

fn cleanup_empty_parent_directories(path: &Path, stop_at: &Path) {
    let mut current = path.parent();
    while let Some(directory) = current {
        if directory == stop_at || !directory.starts_with(stop_at) {
            break;
        }

        match fs::remove_dir(directory) {
            Ok(()) => current = directory.parent(),
            Err(_) => break,
        }
    }
}

fn find_trash_record(records: &[TrashRecord], trash_path: &str) -> Option<usize> {
    records.iter().position(|record| record.trash_path == trash_path)
}

fn classify_entry(path: &Path) -> Result<TrashItemType, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Unable to read metadata for {}: {error}", path.display()))?;
    if metadata.is_dir() {
        return Ok(TrashItemType::Folder);
    }
    if metadata.is_file() {
        return Ok(TrashItemType::Note);
    }
    Err(format!("Unsupported entry type at {}", path.display()))
}

fn move_entry_to_target(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create directory {}: {error}", parent.display()))?;
    }

    fs::rename(source, target)
        .map_err(|error| format!("Unable to move {} to {}: {error}", source.display(), target.display()))
}

#[tauri::command]
fn set_vault_path(path: String, state: tauri::State<VaultState>) -> Result<String, String> {
    let canonical = canonicalize_directory(Path::new(&path))?;
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
    list_directory_entries(&vault_path)
}

#[tauri::command]
fn list_trash_records(state: tauri::State<VaultState>) -> Result<Vec<TrashRecord>, String> {
    let vault_path = get_selected_vault(&state)?;
    let mut records = load_trash_index(&vault_path)?;
    records.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
    Ok(records)
}

#[tauri::command]
fn create_note(
    title: String,
    folder_path: Option<String>,
    state: tauri::State<VaultState>,
) -> Result<Note, String> {
    let vault_path = get_selected_vault(&state)?;
    let target_directory = resolve_target_directory(&vault_path, folder_path)?;
    let trimmed_title = title.trim();
    let base_slug = {
        let slug = slugify(trimmed_title);
        if slug.is_empty() {
            String::from("untitled")
        } else {
            slug
        }
    };

    let note_path = ensure_unique_path(&target_directory.join(format!("{base_slug}.md")), true)?;
    fs::write(&note_path, "")
        .map_err(|error| format!("Unable to create note at {}: {error}", note_path.display()))?;

    let path_string = path_to_string(&note_path);
    Ok(Note {
        id: path_string.clone(),
        title: note_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(trimmed_title)
            .to_string(),
        path: path_string,
        tags: Vec::new(),
        updated_at: current_timestamp_ms(),
        updated_at_source: UpdatedAtSource::Filesystem,
    })
}

#[tauri::command]
fn create_folder(
    name: String,
    folder_path: Option<String>,
    state: tauri::State<VaultState>,
) -> Result<FolderItem, String> {
    let vault_path = get_selected_vault(&state)?;
    let target_directory = resolve_target_directory(&vault_path, folder_path)?;
    let trimmed_name = name.trim();
    let base_slug = {
        let slug = slugify(trimmed_name);
        if slug.is_empty() {
            String::from("new-folder")
        } else {
            slug
        }
    };

    let folder_path = ensure_unique_path(&target_directory.join(&base_slug), false)?;
    fs::create_dir_all(&folder_path)
        .map_err(|error| format!("Unable to create folder at {}: {error}", folder_path.display()))?;

    let path_string = path_to_string(&folder_path);
    Ok(FolderItem {
        id: path_string.clone(),
        name: folder_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&base_slug)
            .to_string(),
        path: path_string,
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
    fs::write(&note_path, content)
        .map_err(|error| format!("Unable to write note at {}: {error}", note_path.display()))
}

#[tauri::command]
fn delete_note(path: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let note_path = ensure_file_in_vault(&vault_path, Path::new(path.trim()))?;
    fs::remove_file(&note_path)
        .map_err(|error| format!("Unable to delete note at {}: {error}", note_path.display()))
}

#[tauri::command]
fn trash_entry(path: String, state: tauri::State<VaultState>) -> Result<TrashRecord, String> {
    let vault_path = get_selected_vault(&state)?;
    let entry_path = ensure_live_path_in_vault(&vault_path, Path::new(path.trim()))?;
    let item_type = classify_entry(&entry_path)?;
    let relative_path = entry_path
        .strip_prefix(&vault_path)
        .map_err(|_| String::from("Unable to resolve a relative vault path."))?;
    let trash_path = ensure_unique_path(
        &trash_items_root(&vault_path).join(relative_path),
        item_type == TrashItemType::Note,
    )?;

    move_entry_to_target(&entry_path, &trash_path)?;

    let mut records = load_trash_index(&vault_path)?;
    let record = TrashRecord {
        original_path: path_to_string(&entry_path),
        trash_path: path_to_string(&trash_path),
        item_type,
        deleted_at: current_timestamp_ms(),
    };
    records.push(record.clone());
    save_trash_index(&vault_path, &records)?;
    Ok(record)
}

#[tauri::command]
fn restore_trashed_item(
    trash_path: String,
    state: tauri::State<VaultState>,
) -> Result<String, String> {
    let vault_path = get_selected_vault(&state)?;
    let mut records = load_trash_index(&vault_path)?;
    let Some(record_index) = find_trash_record(&records, trash_path.trim()) else {
        return Err(String::from("Trash record not found."));
    };

    let record = records.remove(record_index);
    let source_path = PathBuf::from(&record.trash_path);
    if !source_path.exists() {
        save_trash_index(&vault_path, &records)?;
        return Err(format!("Trashed item is missing at {}", source_path.display()));
    }

    let original_path = PathBuf::from(&record.original_path);
    if !original_path.starts_with(&vault_path) || original_path.starts_with(trash_root(&vault_path)) {
        return Err(String::from("Original restore path is invalid."));
    }

    let restored_path = ensure_unique_path(&original_path, record.item_type == TrashItemType::Note)?;
    move_entry_to_target(&source_path, &restored_path)?;
    save_trash_index(&vault_path, &records)?;
    cleanup_empty_parent_directories(&source_path, &trash_items_root(&vault_path));

    Ok(path_to_string(&restored_path))
}

#[tauri::command]
fn permanently_delete_trashed_item(
    trash_path: String,
    state: tauri::State<VaultState>,
) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let mut records = load_trash_index(&vault_path)?;
    let Some(record_index) = find_trash_record(&records, trash_path.trim()) else {
        return Err(String::from("Trash record not found."));
    };

    let record = records.remove(record_index);
    let target_path = PathBuf::from(&record.trash_path);
    if target_path.exists() {
        if record.item_type == TrashItemType::Folder {
            fs::remove_dir_all(&target_path).map_err(|error| {
                format!("Unable to remove trashed folder at {}: {error}", target_path.display())
            })?;
        } else {
            fs::remove_file(&target_path).map_err(|error| {
                format!("Unable to remove trashed file at {}: {error}", target_path.display())
            })?;
        }
    }

    save_trash_index(&vault_path, &records)?;
    cleanup_empty_parent_directories(&target_path, &trash_items_root(&vault_path));
    Ok(())
}

#[tauri::command]
fn rename_entry(
    path: String,
    next_name: String,
    state: tauri::State<VaultState>,
) -> Result<String, String> {
    let vault_path = get_selected_vault(&state)?;
    let entry_path = ensure_live_path_in_vault(&vault_path, Path::new(path.trim()))?;
    let item_type = classify_entry(&entry_path)?;
    let parent_directory = entry_path
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", entry_path.display()))?;

    let trimmed_name = next_name.trim();
    if trimmed_name.is_empty() {
        return Err(String::from("A name is required."));
    }

    let target_name = if item_type == TrashItemType::Note {
        let slug = slugify(trimmed_name);
        if slug.is_empty() {
            String::from("untitled.md")
        } else {
            format!("{slug}.md")
        }
    } else {
        let slug = slugify(trimmed_name);
        if slug.is_empty() {
            String::from("untitled-folder")
        } else {
            slug
        }
    };

    let proposed_target = parent_directory.join(target_name);
    if proposed_target == entry_path {
        return Ok(path_to_string(&entry_path));
    }

    let resolved_target = ensure_unique_path(&proposed_target, item_type == TrashItemType::Note)?;
    move_entry_to_target(&entry_path, &resolved_target)?;
    Ok(path_to_string(&resolved_target))
}

#[tauri::command]
fn move_entry(
    path: String,
    folder_path: Option<String>,
    state: tauri::State<VaultState>,
) -> Result<String, String> {
    let vault_path = get_selected_vault(&state)?;
    let entry_path = ensure_live_path_in_vault(&vault_path, Path::new(path.trim()))?;
    let item_type = classify_entry(&entry_path)?;
    let target_directory = resolve_target_directory(&vault_path, folder_path)?;

    if item_type == TrashItemType::Folder && target_directory.starts_with(&entry_path) {
        return Err(String::from("Cannot move a folder inside itself."));
    }

    let current_parent = entry_path.parent().unwrap_or(&vault_path);
    if current_parent == target_directory {
        return Ok(path_to_string(&entry_path));
    }

    let file_name = entry_path
        .file_name()
        .ok_or_else(|| format!("Path has no file name: {}", entry_path.display()))?;
    let proposed_target = target_directory.join(file_name);
    let resolved_target = ensure_unique_path(&proposed_target, item_type == TrashItemType::Note)?;
    move_entry_to_target(&entry_path, &resolved_target)?;
    Ok(path_to_string(&resolved_target))
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
            list_trash_records,
            create_note,
            create_folder,
            read_note,
            write_note,
            delete_note,
            trash_entry,
            restore_trashed_item,
            permanently_delete_trashed_item,
            rename_entry,
            move_entry
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

