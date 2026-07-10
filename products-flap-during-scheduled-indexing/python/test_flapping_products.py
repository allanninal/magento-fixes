from flag_flapping_products import is_product_flapping, advance_missing_tracker

BASELINE = {"sku-a", "sku-b", "sku-c"}


def test_no_missing_when_everything_present():
    result = is_product_flapping(BASELINE, BASELINE, BASELINE, {}, 1000, 60)
    assert result["flapping"] == set()
    assert result["stuck"] == set()


def test_new_miss_is_flapping_not_stuck():
    current_category = BASELINE - {"sku-a"}
    result = is_product_flapping(BASELINE, current_category, BASELINE, {}, 1000, 60)
    assert result["flapping"] == {"sku-a"}
    assert result["stuck"] == set()


def test_recently_missing_stays_flapping():
    previous_missing = {"sku-a": 1000}
    current_category = BASELINE - {"sku-a"}
    result = is_product_flapping(BASELINE, current_category, BASELINE, previous_missing, 1090, 60)
    assert result["flapping"] == {"sku-a"}
    assert result["stuck"] == set()


def test_missing_past_three_cycles_is_stuck():
    previous_missing = {"sku-a": 1000}
    current_category = BASELINE - {"sku-a"}
    result = is_product_flapping(BASELINE, current_category, BASELINE, previous_missing, 1000 + 181, 60)
    assert result["stuck"] == {"sku-a"}
    assert result["flapping"] == set()


def test_missing_from_search_is_tracked_separately():
    current_search = BASELINE - {"sku-b"}
    result = is_product_flapping(BASELINE, BASELINE, current_search, {}, 1000, 60)
    assert result["missing_from_search"] == {"sku-b"}
    assert result["missing_from_category"] == set()


def test_missing_from_both_counts_once_in_missing_now_semantics():
    current_category = BASELINE - {"sku-a"}
    current_search = BASELINE - {"sku-a"}
    result = is_product_flapping(BASELINE, current_category, current_search, {}, 1000, 60)
    assert result["missing_from_category"] == {"sku-a"}
    assert result["missing_from_search"] == {"sku-a"}
    assert result["flapping"] == {"sku-a"}


def test_advance_missing_tracker_keeps_first_seen_ts():
    previous_missing = {"sku-a": 500}
    updated = advance_missing_tracker(previous_missing, {"sku-a", "sku-b"}, 900)
    assert updated["sku-a"] == 500
    assert updated["sku-b"] == 900


def test_advance_missing_tracker_drops_recovered_skus():
    previous_missing = {"sku-a": 500, "sku-b": 600}
    updated = advance_missing_tracker(previous_missing, {"sku-a"}, 900)
    assert "sku-b" not in updated


def test_advance_missing_tracker_empty_when_nothing_missing():
    previous_missing = {"sku-a": 500}
    updated = advance_missing_tracker(previous_missing, set(), 900)
    assert updated == {}
