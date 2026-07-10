from diagnose_missing_product import decide_storefront_eligibility

CATEGORIES = [{"id": 2, "isActive": True}, {"id": 9, "isActive": False}]


def product(**over):
    base = {"status": 1, "visibility": 4, "websiteIds": [1], "categoryIds": [2]}
    base.update(over)
    return base


def test_eligible_when_all_conditions_pass():
    result = decide_storefront_eligibility(product(), CATEGORIES, 1)
    assert result == {"eligible": True, "reasons": []}


def test_disabled_is_flagged():
    result = decide_storefront_eligibility(product(status=2), CATEGORIES, 1)
    assert result["eligible"] is False
    assert "disabled" in result["reasons"]


def test_not_visible_individually_is_flagged():
    result = decide_storefront_eligibility(product(visibility=1), CATEGORIES, 1)
    assert "not_visible_individually" in result["reasons"]


def test_visibility_catalog_only_is_eligible():
    result = decide_storefront_eligibility(product(visibility=2), CATEGORIES, 1)
    assert result["eligible"] is True


def test_website_not_assigned_is_flagged():
    result = decide_storefront_eligibility(product(websiteIds=[2]), CATEGORIES, 1)
    assert "website_not_assigned" in result["reasons"]


def test_no_active_category_is_flagged():
    result = decide_storefront_eligibility(product(categoryIds=[9]), CATEGORIES, 1)
    assert "no_active_category" in result["reasons"]


def test_no_categories_at_all_is_flagged():
    result = decide_storefront_eligibility(product(categoryIds=[]), CATEGORIES, 1)
    assert "no_active_category" in result["reasons"]


def test_multiple_failures_all_listed():
    result = decide_storefront_eligibility(
        product(status=2, visibility=1, websiteIds=[], categoryIds=[9]), CATEGORIES, 1
    )
    assert set(result["reasons"]) == {
        "disabled", "not_visible_individually", "website_not_assigned", "no_active_category",
    }


def test_eligible_with_at_least_one_active_category_among_several():
    result = decide_storefront_eligibility(product(categoryIds=[9, 2]), CATEGORIES, 1)
    assert result["eligible"] is True
