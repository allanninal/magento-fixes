from find_missing_website_assignment import is_missing_website_assignment


def product(**over):
    base = {"sku": "SKU-1", "extension_attributes": {"website_ids": [1]}}
    base.update(over)
    return base


def test_not_affected_when_website_ids_present():
    result = is_missing_website_assignment(product(), [1])
    assert result == {"sku": "SKU-1", "affected": False, "missingWebsiteIds": []}


def test_affected_when_website_ids_empty():
    result = is_missing_website_assignment(product(extension_attributes={"website_ids": []}), [1])
    assert result["affected"] is True
    assert result["missingWebsiteIds"] == [1]


def test_affected_when_extension_attributes_missing():
    result = is_missing_website_assignment({"sku": "SKU-2"}, [1])
    assert result == {"sku": "SKU-2", "affected": True, "missingWebsiteIds": [1]}


def test_affected_when_expected_website_id_not_in_actual():
    result = is_missing_website_assignment(product(extension_attributes={"website_ids": [2]}), [1])
    assert result["affected"] is True
    assert result["missingWebsiteIds"] == [1]


def test_not_affected_when_actual_has_extra_websites():
    result = is_missing_website_assignment(product(extension_attributes={"website_ids": [1, 2]}), [1])
    assert result["affected"] is False
    assert result["missingWebsiteIds"] == []


def test_supports_multiple_expected_website_ids():
    result = is_missing_website_assignment(product(extension_attributes={"website_ids": [1]}), [1, 2])
    assert result["affected"] is True
    assert result["missingWebsiteIds"] == [2]
