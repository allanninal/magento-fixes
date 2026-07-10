from flag_negative_source_masked import is_impossible_stock_total


def row(source_code, quantity, status=1):
    return {"sourceCode": source_code, "quantity": quantity, "status": status}


def test_flagged_when_negative_masked_by_healthy_sources():
    rows = [row("S1", 2), row("S2", 3), row("S3", -29, status=0)]
    result = is_impossible_stock_total(rows)
    assert result["flagged"] is True
    assert result["sum"] == -24
    assert "S3" in result["negativeSources"]


def test_not_flagged_when_no_negative_rows():
    rows = [row("S1", 2), row("S2", 3)]
    result = is_impossible_stock_total(rows)
    assert result["flagged"] is False
    assert result["sum"] == 5


def test_flagged_when_naive_sum_is_non_negative_with_negative_row():
    rows = [row("S1", 5), row("S2", -2, status=0)]
    result = is_impossible_stock_total(rows)
    assert result["flagged"] is True
    assert result["sum"] == 3


def test_flagged_when_healthy_source_partially_offsets_out_of_stock_negative():
    # sum (-3) is still negative but greater than the culprit's own -5, so the
    # deficit was partially masked by S1 even though the total stayed negative.
    rows = [row("S1", 2), row("S2", -5, status=0)]
    result = is_impossible_stock_total(rows)
    assert result["sum"] == -3
    assert result["flagged"] is True


def test_not_flagged_when_single_out_of_stock_negative_source_alone():
    # No other source to mask the deficit: sum equals the culprit's own quantity,
    # so it is not masked, just a plain negative total from one source.
    rows = [row("S1", -5, status=0)]
    result = is_impossible_stock_total(rows)
    assert result["sum"] == -5
    assert result["flagged"] is False


def test_reason_names_the_culprit_source():
    rows = [row("S1", 2), row("S2", -2, status=0)]
    result = is_impossible_stock_total(rows)
    assert result["flagged"] is True
    assert "S2" in result["reason"]
    assert "out_of_stock" in result["reason"]


def test_negative_in_stock_source_included_in_negative_sources():
    rows = [row("S1", 10), row("S2", -1, status=1)]
    result = is_impossible_stock_total(rows)
    assert "S2" in result["negativeSources"]
    assert result["sum"] == 9


def test_empty_rows_not_flagged():
    result = is_impossible_stock_total([])
    assert result["flagged"] is False
    assert result["sum"] == 0
    assert result["negativeSources"] == []


def test_multiple_negative_sources_all_listed():
    rows = [row("S1", 10), row("S2", -3, status=0), row("S3", -4, status=1)]
    result = is_impossible_stock_total(rows)
    assert result["sum"] == 3
    assert result["flagged"] is True
    assert set(result["negativeSources"]) == {"S2", "S3"}
