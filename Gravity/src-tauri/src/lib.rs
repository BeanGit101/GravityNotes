use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

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

struct ParsedTemplateSeed {
    body: String,
    subject: Option<String>,
    tags: Option<Vec<String>>,
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

fn templates_directory(vault_path: &Path) -> PathBuf {
    vault_path.join(".gravity").join("templates")
}

fn ensure_templates_directory(vault_path: &Path) -> Result<PathBuf, String> {
    let directory = templates_directory(vault_path);
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Unable to create templates directory {}: {error}",
            directory.display()
        )
    })?;
    canonicalize_directory(&directory)
}

fn ensure_template_file(vault_path: &Path, path: &Path) -> Result<PathBuf, String> {
    let templates_path = ensure_templates_directory(vault_path)?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Unable to access template {}: {error}", path.display()))?;

    if !canonical.starts_with(&templates_path) {
        return Err(String::from(
            "Requested template is outside the selected vault template directory.",
        ));
    }

    if !canonical.is_file() {
        return Err(format!("Path is not a file: {}", canonical.display()));
    }

    let file_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Invalid template file name: {}", canonical.display()))?;
    if !is_markdown_file(file_name) {
        return Err(format!(
            "Template must be a markdown file: {}",
            canonical.display()
        ));
    }

    Ok(canonical)
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

fn clean_optional_string(value: Option<String>) -> Option<String> {
    value.map(|entry| entry.trim().to_string()).filter(|entry| !entry.is_empty())
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
        .map(|tag| tag.trim().trim_matches('"').trim_matches('\''))
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
            collected.push(tag.trim().trim_matches('"').trim_matches('\'').to_string());
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

fn template_summary_from_path(path: &Path) -> Result<TemplateSummary, String> {
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

fn template_content_from_path(path: &Path) -> Result<TemplateContent, String> {
    let summary = template_summary_from_path(path)?;
    let parsed = parse_template_markdown(
        &fs::read_to_string(path)
            .map_err(|error| format!("Unable to read template at {}: {error}", path.display()))?,
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

fn sort_templates(items: &mut [TemplateSummary]) {
    items.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
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
            if entry_name == ".gravity" {
                continue;
            }

            let mut children = list_directory_entries(&entry_path)?;
            sort_items(&mut children);
            items.push(FileSystemItem::Folder {
                id: path_to_string(&entry_path),
                name: entry_name,
                path: path_to_string(&entry_path),
                children,
            });
        } else if file_type.is_file() && is_markdown_file(&entry_name) {
            items.push(FileSystemItem::File {
                id: path_to_string(&entry_path),
                title: strip_markdown_extension(&entry_name).to_string(),
                path: path_to_string(&entry_path),
            });
        }
    }

    sort_items(&mut items);
    Ok(items)
}

fn list_templates_in_directory(directory: &Path) -> Result<Vec<TemplateSummary>, String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Unable to read directory {}: {error}", directory.display()))?;

    let mut templates = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let entry_path = entry.path();
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to read file type for {}: {error}", entry_name))?;

        if file_type.is_file() && is_markdown_file(&entry_name) {
            templates.push(template_summary_from_path(&entry_path)?);
        }
    }

    sort_templates(&mut templates);
    Ok(templates)
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

fn create_note_file(
    target_directory: &Path,
    title: &str,
    initial_content: &str,
) -> Result<Note, String> {
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

        fs::write(&note_path, initial_content).map_err(|error| {
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

fn create_template_file(
    vault_path: &Path,
    name: &str,
    body: String,
    subject: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<TemplateContent, String> {
    let templates_path = ensure_templates_directory(vault_path)?;
    let base_name = sanitize_template_name(name);
    let seed = ParsedTemplateSeed {
        body,
        subject,
        tags,
    };
    let markdown = serialize_template_markdown(&seed);

    for suffix in 0..1000 {
        let resolved_name = if suffix == 0 {
            base_name.clone()
        } else {
            format!("{base_name} {suffix}")
        };
        let template_path = templates_path.join(format!("{resolved_name}.md"));
        if template_path.exists() {
            continue;
        }

        fs::write(&template_path, markdown.as_bytes()).map_err(|error| {
            format!(
                "Unable to create template at {}: {error}",
                template_path.display()
            )
        })?;

        return template_content_from_path(&template_path);
    }

    Err(String::from("Unable to create a unique template file."))
}

fn rename_template_file(
    vault_path: &Path,
    template_path: &Path,
    new_name: &str,
) -> Result<TemplateSummary, String> {
    let current_path = ensure_template_file(vault_path, template_path)?;
    let templates_path = ensure_templates_directory(vault_path)?;
    let resolved_name = sanitize_template_name(new_name);
    let target_path = templates_path.join(format!("{resolved_name}.md"));

    if current_path == target_path {
        return template_summary_from_path(&current_path);
    }

    if target_path.exists() {
        return Err(format!(
            "Template already exists at {}",
            target_path.display()
        ));
    }

    fs::rename(&current_path, &target_path).map_err(|error| {
        format!(
            "Unable to rename template from {} to {}: {error}",
            current_path.display(),
            target_path.display()
        )
    })?;

    template_summary_from_path(&target_path)
}

fn delete_template_file(vault_path: &Path, template_path: &Path) -> Result<(), String> {
    let template_path = ensure_template_file(vault_path, template_path)?;
    fs::remove_file(&template_path).map_err(|error| {
        format!(
            "Unable to delete template at {}: {error}",
            template_path.display()
        )
    })
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
fn list_templates(state: tauri::State<VaultState>) -> Result<Vec<TemplateSummary>, String> {
    let vault_path = get_selected_vault(&state)?;
    let templates_path = templates_directory(&vault_path);
    if !templates_path.exists() {
        return Ok(Vec::new());
    }

    let templates_path = canonicalize_directory(&templates_path)?;
    list_templates_in_directory(&templates_path)
}

#[tauri::command]
fn read_template(path: String, state: tauri::State<VaultState>) -> Result<TemplateContent, String> {
    let vault_path = get_selected_vault(&state)?;
    let template_path = ensure_template_file(&vault_path, Path::new(path.trim()))?;
    template_content_from_path(&template_path)
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
    create_note_file(&target_directory, &title, &normalize_markdown(&initial_content))
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
fn write_note(
    path: String,
    content: String,
    state: tauri::State<VaultState>,
) -> Result<(), String> {
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
fn create_template(
    name: String,
    body: String,
    subject: Option<String>,
    tags: Option<Vec<String>>,
    state: tauri::State<VaultState>,
) -> Result<TemplateContent, String> {
    let vault_path = get_selected_vault(&state)?;
    create_template_file(
        &vault_path,
        &name,
        normalize_markdown(&body),
        subject,
        tags,
    )
}

#[tauri::command]
fn rename_template(
    path: String,
    new_name: String,
    state: tauri::State<VaultState>,
) -> Result<TemplateSummary, String> {
    let vault_path = get_selected_vault(&state)?;
    rename_template_file(&vault_path, Path::new(path.trim()), &new_name)
}

#[tauri::command]
fn delete_template(path: String, state: tauri::State<VaultState>) -> Result<(), String> {
    let vault_path = get_selected_vault(&state)?;
    delete_template_file(&vault_path, Path::new(path.trim()))
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
            list_templates,
            read_template,
            create_note,
            create_folder,
            read_note,
            write_note,
            delete_note,
            create_template,
            rename_template,
            delete_template
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

