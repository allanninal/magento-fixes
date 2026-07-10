from reindex_anomaly import decide_reindex_anomaly

PROCESSING = {"code": "catalog_product_price", "status": "processing"}
INVALID = {"code": "catalog_product_price", "status": "invalid"}
VALID = {"code": "catalog_product_price", "status": "valid"}


def test_transient_gap_when_missing_returns_and_indexer_processing():
    before = ["sku-1", "sku-2", "sku-3"]
    during = ["sku-1", "sku-3"]
    after = ["sku-1", "sku-2", "sku-3"]
    result = decide_reindex_anomaly(before, during, after, PROCESSING)
    assert result["isTransientDropDetected"] is True
    assert result["missingDuringWindow"] == ["sku-2"]
    assert result["recommendation"] == "flag_transient_index_gap"


def test_permanent_loss_when_sku_never_returns():
    before = ["sku-1", "sku-2"]
    during = ["sku-1"]
    after = ["sku-1"]
    result = decide_reindex_anomaly(before, during, after, PROCESSING)
    assert result["isTransientDropDetected"] is False
    assert result["missingDuringWindow"] == ["sku-2"]
    assert result["recommendation"] == "flag_permanent_loss"


def test_permanent_loss_even_if_indexer_says_valid():
    before = ["sku-1", "sku-2"]
    during = ["sku-1"]
    after = ["sku-1"]
    result = decide_reindex_anomaly(before, during, after, VALID)
    assert result["recommendation"] == "flag_permanent_loss"


def test_ok_when_nothing_missing_and_counts_match():
    before = ["sku-1", "sku-2"]
    result = decide_reindex_anomaly(before, before, before, VALID)
    assert result["recommendation"] == "ok"
    assert result["falsePositive"] is False


def test_false_positive_when_nothing_missing_but_counts_differ():
    before = ["sku-1", "sku-2"]
    after = ["sku-1", "sku-2", "sku-3"]
    result = decide_reindex_anomaly(before, before, after, VALID)
    assert result["recommendation"] == "ok"
    assert result["falsePositive"] is True


def test_transient_gap_detected_when_indexer_status_invalid():
    before = ["sku-1", "sku-2"]
    during = ["sku-1"]
    after = ["sku-1", "sku-2"]
    result = decide_reindex_anomaly(before, during, after, INVALID)
    assert result["recommendation"] == "flag_transient_index_gap"


def test_missing_set_computed_from_before_minus_during_only():
    # A SKU that appears only during (not before) should not count as "missing".
    before = ["sku-1"]
    during = ["sku-1", "sku-2"]
    after = ["sku-1", "sku-2"]
    result = decide_reindex_anomaly(before, during, after, PROCESSING)
    assert result["missingDuringWindow"] == []
    assert result["recommendation"] == "ok"
