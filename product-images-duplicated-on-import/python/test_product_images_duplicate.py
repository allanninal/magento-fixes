from find_duplicate_gallery_entries import find_duplicate_gallery_entries, safe_duplicate_ids, normalized_stem


def entry(id, file, hash=None, types=None):
    return {"id": id, "file": file, "hash": hash, "types": types or []}


def test_no_duplicates_when_all_hashes_differ():
    entries = [entry(1, "/m/b/a.jpg", "h1"), entry(2, "/m/b/b.jpg", "h2")]
    assert find_duplicate_gallery_entries(entries) == []


def test_finds_duplicate_by_hash_keeps_lowest_id():
    entries = [entry(3, "/m/b/a_2.jpg", "h1"), entry(1, "/m/b/a.jpg", "h1"), entry(2, "/m/b/a_1.jpg", "h1")]
    result = find_duplicate_gallery_entries(entries)
    assert len(result) == 1
    assert result[0]["keepId"] == 1
    assert result[0]["duplicateIds"] == [2, 3]
    assert result[0]["reason"] == "identical file content"


def test_falls_back_to_normalized_filename_without_hash():
    entries = [entry(1, "/m/b/photo.jpg"), entry(2, "/m/b/photo_1.jpg")]
    result = find_duplicate_gallery_entries(entries)
    assert len(result) == 1
    assert result[0]["reason"] == "identical normalized filename"


def test_different_pictures_are_not_grouped():
    entries = [entry(1, "/m/b/front.jpg", "h1"), entry(2, "/m/b/back.jpg", "h2"), entry(3, "/m/b/side.jpg", "h3")]
    assert find_duplicate_gallery_entries(entries) == []


def test_returns_empty_list_for_empty_input():
    assert find_duplicate_gallery_entries([]) == []


def test_multiple_groups_reported_independently():
    entries = [
        entry(1, "/m/b/a.jpg", "h1"), entry(2, "/m/b/a_1.jpg", "h1"),
        entry(3, "/m/b/b.jpg", "h2"), entry(4, "/m/b/b_1.jpg", "h2"),
        entry(5, "/m/b/c.jpg", "h3"),
    ]
    result = find_duplicate_gallery_entries(entries)
    assert len(result) == 2
    keep_ids = sorted(g["keepId"] for g in result)
    assert keep_ids == [1, 3]


def test_safe_duplicate_ids_allows_removal_when_no_role():
    entries = [entry(1, "/m/b/a.jpg", "h1"), entry(2, "/m/b/a_1.jpg", "h1")]
    group = {"keepId": 1, "duplicateIds": [2], "reason": "identical file content"}
    assert safe_duplicate_ids(entries, group) == [2]


def test_safe_duplicate_ids_blocks_when_role_not_covered_by_keeper():
    entries = [
        entry(1, "/m/b/a.jpg", "h1", types=[]),
        entry(2, "/m/b/a_1.jpg", "h1", types=["base"]),
    ]
    group = {"keepId": 1, "duplicateIds": [2], "reason": "identical file content"}
    assert safe_duplicate_ids(entries, group) == []


def test_safe_duplicate_ids_allows_when_keeper_covers_role():
    entries = [
        entry(1, "/m/b/a.jpg", "h1", types=["base", "small_image"]),
        entry(2, "/m/b/a_1.jpg", "h1", types=["base"]),
    ]
    group = {"keepId": 1, "duplicateIds": [2], "reason": "identical file content"}
    assert safe_duplicate_ids(entries, group) == [2]


def test_safe_duplicate_ids_never_removes_only_image():
    entries = [entry(1, "/m/b/a.jpg", "h1")]
    group = {"keepId": 1, "duplicateIds": [], "reason": "identical file content"}
    assert safe_duplicate_ids(entries, group) == []


def test_normalized_stem_strips_disambiguation_suffix():
    assert normalized_stem("/m/b/photo_12.jpg") == "photo.jpg"
    assert normalized_stem("/m/b/photo.jpg") == "photo.jpg"
