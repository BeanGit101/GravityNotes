use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const TRASH_DIR_NAME: &str = ".gravity-trash";
const TRASH_ITEMS_DIR_NAME: &str = "items";
const TRASH_META_DIR_NAME: &str = "meta";
const TEMPLATES_DIR_NAME: &str = ".gravity-templates";

#[derive(Default)]
struct VaultState {
    selected_path: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
struct Note {
    id: String,
    title: String,
    path: String,
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
    File { id: String, title: String, path: String },
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

#[derive(Serialize)]
struct TemplateItem {
    id: String,
    name: String,
    path: String,
    content: String,
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

fn templates_directory(vault_path: &Path) -> PathBuf {
    vault_path.join(TEMPLATES_DIR_NAME)
}

fn ensure_templates_layout(vault_path: &Path) -> Result<(), String> {
    let templates = templates_directory(vault_path);
    fs::create_dir_all(&templates)
        .map_err(|error| format!("Unable to create templates directory {}: {error}", templates.display()))
}

fn ensure_template_file_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access template {}: {error}", path.display()))?;
    if !canonical.starts_with(templates_directory(vault_path)) {
        return Err(String::from(
            "Requested template is outside the managed templates directory.",
        ));
    }
    if !canonical.is_file() {
        return Err(format!("Template path is not a file: {}", canonical.display()));
    }
    Ok(canonical)
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

fn ensure_directory_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = canonicalize_directory(path)?;
    if !canonical.starts_with(vault_path) {
        return Err(String::from("Requested folder is outside the selected vault."));
    }
    if is_inside_trash(vault_path, &canonical) {
        return Err(String::from("Requested folder is inside the app-managed trash."));
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

fn folder_name(name: &str) -> String {
    let slug = slugify(name);
    if slug.is_empty() {
        String::from("new-folder")
    } else {
        slug
    }
}

fn build_note(path: &Path) -> Note {
    let path_string = path_to_string(path);
    Note {
        id: path_string.clone(),
        title: file_title_from_path(path),
        path: path_string,
    }
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
    let mut items = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let entry_path = entry.path();
        if entry_path == trash_root_path {
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
        } else if file_type.is_file() && entry_name.to_ascii_lowercase().ends_with(".md") {
            items.push(FileSystemItem::File {
                id: path_to_string(&entry_path),
                title: file_title_from_path(&entry_path),
                path: path_to_string(&entry_path),
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
fn create_note(title: String, folder_path: Option<String>, state: tauri::State<VaultState>) -> Result<Note, String> {
    let vault_path = get_selected_vault(&state)?;
    let target_directory = resolve_target_directory(&vault_path, folder_path)?;
    let desired_path = target_directory.join(note_file_name(title.trim()));
    let note_path = find_available_path(&desired_path, true);
    fs::write(&note_path, "")
        .map_err(|error| format!("Unable to create note at {}: {error}", note_path.display()))?;
    Ok(build_note(&note_path))
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
        return Ok(build_note(&note_path));
    }
    fs::rename(&note_path, &next_path).map_err(|error| {
        format!(
            "Unable to rename note {} to {}: {error}",
            note_path.display(),
            next_path.display()
        )
    })?;
    move_note_sidecar(&note_path, &next_path)?;
    Ok(build_note(&next_path))
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
        return Ok(build_note(&note_path));
    }
    fs::rename(&note_path, &next_path).map_err(|error| {
        format!(
            "Unable to move note {} to {}: {error}",
            note_path.display(),
            next_path.display()
        )
    })?;
    move_note_sidecar(&note_path, &next_path)?;
    Ok(build_note(&next_path))
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
fn list_templates(state: tauri::State<VaultState>) -> Result<Vec<TemplateItem>, String> {
    let vault_path = get_selected_vault(&state)?;
    ensure_templates_layout(&vault_path)?;
    let entries = fs::read_dir(templates_directory(&vault_path)).map_err(|error| {
        format!(
            "Unable to read templates directory {}: {error}",
            templates_directory(&vault_path).display()
        )
    })?;

    let mut templates = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read template entry: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to read template file type: {error}"))?;
        if file_type.is_file() && path.extension().and_then(|value| value.to_str()) == Some("md") {
            templates.push(build_template_item(&path)?);
        }
    }

    templates.sort_by(|left, right| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()));
    Ok(templates)
}

#[tauri::command]
fn create_template(name: String, content: String, state: tauri::State<VaultState>) -> Result<TemplateItem, String> {
    let vault_path = get_selected_vault(&state)?;
    ensure_templates_layout(&vault_path)?;
    let desired_path = templates_directory(&vault_path).join(note_file_name(name.trim()));
    let template_path = find_available_path(&desired_path, true);
    fs::write(&template_path, content)
        .map_err(|error| format!("Unable to create template at {}: {error}", template_path.display()))?;
    build_template_item(&template_path)
}

#[tauri::command]
fn read_template(path: String, state: tauri::State<VaultState>) -> Result<TemplateItem, String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file_in_vault(&vault_path, Path::new(path.trim()))?;
    build_template_item(&template_path)
}

#[tauri::command]
fn update_template(path: String, name: Option<String>, content: Option<String>, state: tauri::State<VaultState>) -> Result<TemplateItem, String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file_in_vault(&vault_path, Path::new(path.trim()))?;
    let next_path = if let Some(next_name) = name {
        let desired_path = templates_directory(&vault_path).join(note_file_name(next_name.trim()));
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
fn delete_template(path: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file_in_vault(&vault_path, Path::new(path.trim()))?;
    fs::remove_file(&template_path)
        .map_err(|error| format!("Unable to delete template {}: {error}", template_path.display()))
}

#[tauri::command]
fn apply_template(template_path: String, note_path: String, mode: TemplateApplyMode, state: tauri::State<VaultState>) -> Result<String, String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file_in_vault(&vault_path, Path::new(template_path.trim()))?;
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
            list_templates,
            create_template,
            read_template,
            update_template,
            delete_template,
            apply_template
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}












