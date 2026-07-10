from url_suffix_risk_check import classify_url_suffix_risk


def config(**over):
    base = {
        "productUrlSuffix": "",
        "categoryUrlSuffix": "",
        "useCategoriesPathForProductUrls": True,
        "generateCategoryProductRewrites": False,
    }
    base.update(over)
    return base


def test_affected_when_all_conditions_and_404():
    result = classify_url_suffix_risk(config(), "test-category/test-sub-category/test", 404)
    assert result == {"affected": True, "reason": "empty-suffix-category-path-collision"}


def test_affected_when_all_conditions_and_500():
    result = classify_url_suffix_risk(config(), "test-category/test", 500)
    assert result["affected"] is True


def test_not_affected_when_product_suffix_present():
    result = classify_url_suffix_risk(config(productUrlSuffix="html"), "test-category/test", 404)
    assert result == {"affected": False, "reason": "suffix-present"}


def test_not_affected_when_category_suffix_present():
    result = classify_url_suffix_risk(config(categoryUrlSuffix="html"), "test-category/test", 404)
    assert result == {"affected": False, "reason": "suffix-present"}


def test_not_affected_when_categories_not_used_in_path():
    result = classify_url_suffix_risk(config(useCategoriesPathForProductUrls=False), "test", 404)
    assert result == {"affected": False, "reason": "no-category-path"}


def test_not_affected_when_rewrites_enabled():
    result = classify_url_suffix_risk(config(generateCategoryProductRewrites=True), "test-category/test", 404)
    assert result == {"affected": False, "reason": "rewrites-enabled"}


def test_not_affected_when_path_has_no_category_segment():
    result = classify_url_suffix_risk(config(), "test", 404)
    assert result == {"affected": False, "reason": "no-category-path"}


def test_not_affected_when_status_is_200():
    result = classify_url_suffix_risk(config(), "test-category/test", 200)
    assert result == {"affected": False, "reason": "ok"}


def test_not_affected_when_status_is_301():
    result = classify_url_suffix_risk(config(), "test-category/test", 301)
    assert result == {"affected": False, "reason": "ok"}


def test_category_suffix_alone_blocks_even_without_product_suffix():
    result = classify_url_suffix_risk(
        config(productUrlSuffix="", categoryUrlSuffix="html"), "test-category/test", 500
    )
    assert result == {"affected": False, "reason": "suffix-present"}


def test_both_suffixes_present_is_never_affected():
    result = classify_url_suffix_risk(
        config(productUrlSuffix="html", categoryUrlSuffix="html"), "test-category/test", 404
    )
    assert result["affected"] is False
