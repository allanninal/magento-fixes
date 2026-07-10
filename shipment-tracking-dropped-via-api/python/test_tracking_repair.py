from detect_dropped_tracking import decide_track_repair


def shipment(**over):
    base = {"id": "77", "items": [{"sku": "ABC-1", "qty": 1}], "tracks": []}
    base.update(over)
    return base


EXPECTED_TRACK = {"trackNumber": "1Z999AA10123456784", "title": "UPS", "carrierCode": "ups"}


def test_skip_no_items_when_shipment_has_no_line_items():
    result = decide_track_repair(shipment(items=[]), EXPECTED_TRACK)
    assert result["action"] == "skip_no_items"


def test_skip_has_tracks_when_tracks_already_present():
    result = decide_track_repair(shipment(tracks=[{"trackNumber": "123"}]), EXPECTED_TRACK)
    assert result["action"] == "skip_has_tracks"


def test_flag_missing_track_when_no_expected_track_known():
    result = decide_track_repair(shipment(), None)
    assert result["action"] == "flag_missing_track"


def test_repair_add_track_when_items_no_tracks_and_expected_known():
    result = decide_track_repair(shipment(), EXPECTED_TRACK)
    assert result["action"] == "repair_add_track"


def test_no_items_wins_over_missing_expected_track():
    result = decide_track_repair(shipment(items=[]), None)
    assert result["action"] == "skip_no_items"


def test_has_tracks_wins_over_missing_expected_track():
    result = decide_track_repair(shipment(tracks=[{"trackNumber": "123"}]), None)
    assert result["action"] == "skip_has_tracks"


def test_empty_items_list_explicit():
    result = decide_track_repair(shipment(items=[], tracks=[]), EXPECTED_TRACK)
    assert result["action"] == "skip_no_items"


def test_missing_items_key_treated_as_no_items():
    s = {"id": "88", "tracks": []}
    result = decide_track_repair(s, EXPECTED_TRACK)
    assert result["action"] == "skip_no_items"


def test_missing_tracks_key_treated_as_no_tracks():
    s = {"id": "88", "items": [{"sku": "X"}]}
    result = decide_track_repair(s, EXPECTED_TRACK)
    assert result["action"] == "repair_add_track"
