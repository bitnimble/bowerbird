use std::path::{Path, PathBuf};

pub(crate) fn filename_from(disposition: &str) -> Option<String> {
    let (_, rest) = disposition.split_once("filename=\"")?;
    let (name, _) = rest.split_once('"')?;
    plain(name)
}

pub(crate) fn plain(name: &str) -> Option<String> {
    // Drive-relative Windows names replace the destination when joined.
    let mut parts = Path::new(name).components();
    match (parts.next(), parts.next()) {
        (Some(std::path::Component::Normal(one)), None) => Some(one.to_string_lossy().into_owned()),
        _ => None,
    }
}

pub(crate) fn free(folder: &Path, filename: &str) -> PathBuf {
    let (stem, extension) = match filename.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (filename, String::new()),
    };
    let mut attempt = 1;
    loop {
        let candidate = folder.join(if attempt == 1 {
            filename.to_string()
        } else {
            format!("{stem} ({attempt}){extension}")
        });
        if !candidate.exists() {
            return candidate;
        }
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::{filename_from, free};

    #[test]
    fn a_name_that_is_not_one_plain_component_is_refused() {
        let named = |name: &str| filename_from(&format!("attachment; filename=\"{name}\""));

        assert_eq!(named("DSC02981.jpg").as_deref(), Some("DSC02981.jpg"));
        assert_eq!(named(".DS_Store").as_deref(), Some(".DS_Store"));

        assert_eq!(named("../../etc/passwd"), None);
        assert_eq!(named("/etc/passwd"), None);
        assert_eq!(named("Trip/DSC02981.jpg"), None);
        assert_eq!(named(".."), None);
        assert_eq!(named("."), None);
        assert_eq!(named(""), None);
        #[cfg(windows)]
        {
            assert_eq!(named("C:DSC02981.jpg"), None);
            assert_eq!(named(r"..\..\x.jpg"), None);
        }
    }

    #[test]
    fn a_disposition_with_no_quoted_name_is_refused() {
        assert_eq!(filename_from("attachment"), None);
        assert_eq!(filename_from("attachment; filename=DSC02981.jpg"), None);
    }

    #[test]
    fn a_taken_name_is_numbered_rather_than_overwritten() {
        let folder = tempdir("numbered");
        assert_eq!(free(&folder, "DSC02981.jpg"), folder.join("DSC02981.jpg"));

        std::fs::write(folder.join("DSC02981.jpg"), b"first").unwrap();
        assert_eq!(
            free(&folder, "DSC02981.jpg"),
            folder.join("DSC02981 (2).jpg")
        );

        std::fs::write(folder.join("DSC02981 (2).jpg"), b"second").unwrap();
        assert_eq!(
            free(&folder, "DSC02981.jpg"),
            folder.join("DSC02981 (3).jpg")
        );
    }

    #[test]
    fn a_name_that_is_all_extension_still_numbers() {
        let folder = tempdir("no-extension");
        std::fs::write(folder.join("photo"), b"first").unwrap();
        assert_eq!(free(&folder, "photo"), folder.join("photo (2)"));

        std::fs::write(folder.join(".DS_Store"), b"first").unwrap();
        assert_eq!(free(&folder, ".DS_Store"), folder.join(".DS_Store (2)"));
    }

    fn tempdir(name: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("bowerbird-export-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }
}
