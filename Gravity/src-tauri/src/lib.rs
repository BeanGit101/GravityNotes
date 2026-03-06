use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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

fn ensure_directory_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = canonicalize_directory(path)?;
    if !canonical.starts_with(vault_path) {
        return Err(String::from("Requested folder is outside the selected vault."));
    }
    Ok(canonical)
}

fn ensure_file_in_vault(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access file {}: {error}", path.display()))?;
    if !canonical.starts_with(vault_path) {
        return Err(String::from("Requested file is outside the selected vault."));
    }
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

fn list_directory_entries(directory: &Path) -> Result<Vec<FileSystemItem>, String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Unable to read directory {}: {error}", directory.display()))?;

    let mut items = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let entry_path = entry.path();
        let entry_name = entry.file_name().to_string_lossy().into_owned();
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
            items.push(FileSystemItem::File {
                id: path_to_string(&entry_path),
                title,
                path: path_to_string(&entry_path),
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

    for suffix in 0..1000 {
        let slug = if suffix == 0 {
            base_slug.clone()
        } else {
            format!("{base_slug}-{suffix}")
        };
        let note_path = target_directory.join(format!("{slug}.md"));
        if note_path.exists() {
            continue;
        }

        fs::write(&note_path, "").map_err(|error| {
            format!("Unable to create note at {}: {error}", note_path.display())
        })?;

        let path_string = path_to_string(&note_path);
        return Ok(Note {
            id: path_string.clone(),
            title: if trimmed_title.is_empty() {
                String::from("Untitled")
            } else {
                trimmed_title.to_string()
            },
            path: path_string,
        });
    }

    Err(String::from("Unable to create a unique note file."))
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

    for suffix in 0..1000 {
        let folder_name = if suffix == 0 {
            base_slug.clone()
        } else {
            format!("{base_slug}-{suffix}")
        };
        let folder_path = target_directory.join(&folder_name);
        if folder_path.exists() {
            continue;
        }

        fs::create_dir_all(&folder_path).map_err(|error| {
            format!("Unable to create folder at {}: {error}", folder_path.display())
        })?;

        let path_string = path_to_string(&folder_path);
        return Ok(FolderItem {
            id: path_string.clone(),
            name: folder_name,
            path: path_string,
            item_type: "folder",
            children: Vec::new(),
        });
    }

    Err(String::from("Unable to create a unique folder."))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(VaultState::default())
        .invoke_handler(tauri::generate_handler![
            set_vault_path,
            list_vault_entries,
            create_note,
            create_folder,
            read_note,
            write_note,
            delete_note
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
