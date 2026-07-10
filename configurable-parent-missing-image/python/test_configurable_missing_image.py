from configurable_missing_image import decide_missing_parent_image


def entry(**over):
    base = {"disabled": False, "types": ["image", "small_image", "thumbnail"]}
    base.update(over)
    return base


def test_flags_when_parent_empty_and_child_has_image():
    result = decide_missing_parent_image([], {"CHILD-1": [entry()]})
    assert result["flagged"] is True
    assert result["parentImageCount"] == 0
    assert result["childrenWithImages"] == ["CHILD-1"]
    assert result["recommendedFixSku"] == "CHILD-1"


def test_not_flagged_when_parent_has_image():
    result = decide_missing_parent_image([entry()], {"CHILD-1": [entry()]})
    assert result["flagged"] is False
    assert result["recommendedFixSku"] is None


def test_not_flagged_when_no_children_have_images():
    result = decide_missing_parent_image([], {"CHILD-1": [], "CHILD-2": []})
    assert result["flagged"] is False
    assert result["childrenWithImages"] == []
    assert result["recommendedFixSku"] is None


def test_disabled_entries_do_not_count_as_images():
    result = decide_missing_parent_image(
        [entry(disabled=True)], {"CHILD-1": [entry(disabled=True)]}
    )
    assert result["flagged"] is False


def test_prefers_child_whose_entry_type_includes_image():
    result = decide_missing_parent_image(
        [],
        {
            "CHILD-1": [entry(types=["thumbnail"])],
            "CHILD-2": [entry(types=["image", "small_image"])],
        },
    )
    assert result["flagged"] is True
    assert set(result["childrenWithImages"]) == {"CHILD-1", "CHILD-2"}
    assert result["recommendedFixSku"] == "CHILD-2"


def test_falls_back_to_first_child_when_none_typed_image():
    result = decide_missing_parent_image(
        [],
        {
            "CHILD-1": [entry(types=["thumbnail"])],
            "CHILD-2": [entry(types=["small_image"])],
        },
    )
    assert result["flagged"] is True
    assert result["recommendedFixSku"] == "CHILD-1"


def test_no_children_at_all_is_not_flagged():
    result = decide_missing_parent_image([], {})
    assert result["flagged"] is False
    assert result["parentImageCount"] == 0
    assert result["recommendedFixSku"] is None


def test_mixed_disabled_and_enabled_entries_count_only_enabled():
    result = decide_missing_parent_image(
        [entry(disabled=True), entry(disabled=True)],
        {"CHILD-1": [entry(disabled=True), entry(disabled=False)]},
    )
    assert result["flagged"] is True
    assert result["parentImageCount"] == 0
    assert result["childrenWithImages"] == ["CHILD-1"]
