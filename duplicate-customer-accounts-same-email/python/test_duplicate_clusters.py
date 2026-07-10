from find_duplicate_email_clusters import group_duplicate_email_clusters


def test_single_website_no_cluster():
    customers = [
        {"id": 1, "email": "a@example.com", "website_id": 1},
        {"id": 2, "email": "b@example.com", "website_id": 1},
    ]
    assert group_duplicate_email_clusters(customers) == []


def test_same_email_two_websites_is_a_cluster():
    customers = [
        {"id": 1, "email": "a@example.com", "website_id": 1},
        {"id": 2, "email": "a@example.com", "website_id": 2},
    ]
    result = group_duplicate_email_clusters(customers)
    assert len(result) == 1
    assert result[0]["email"] == "a@example.com"
    assert result[0]["websiteIds"] == [1, 2]
    assert sorted(result[0]["customerIds"]) == [1, 2]


def test_same_email_same_website_twice_is_a_data_integrity_cluster():
    customers = [
        {"id": 1, "email": "a@example.com", "website_id": 1},
        {"id": 2, "email": "a@example.com", "website_id": 1},
    ]
    result = group_duplicate_email_clusters(customers)
    assert len(result) == 1
    assert result[0]["websiteIds"] == [1]
    assert sorted(result[0]["customerIds"]) == [1, 2]


def test_mixed_case_and_whitespace_email_still_clusters():
    customers = [
        {"id": 1, "email": "  A@Example.com", "website_id": 1},
        {"id": 2, "email": "a@example.com  ", "website_id": 2},
    ]
    result = group_duplicate_email_clusters(customers)
    assert len(result) == 1
    assert result[0]["email"] == "a@example.com"
    assert result[0]["websiteIds"] == [1, 2]


def test_no_cluster_when_every_email_is_unique_per_website():
    customers = [
        {"id": 1, "email": "a@example.com", "website_id": 1},
        {"id": 2, "email": "b@example.com", "website_id": 2},
        {"id": 3, "email": "c@example.com", "website_id": 1},
    ]
    assert group_duplicate_email_clusters(customers) == []


def test_empty_email_is_ignored():
    customers = [
        {"id": 1, "email": "", "website_id": 1},
        {"id": 2, "email": None, "website_id": 2},
    ]
    assert group_duplicate_email_clusters(customers) == []


def test_three_websites_same_email_reports_all_ids():
    customers = [
        {"id": 1, "email": "a@example.com", "website_id": 3},
        {"id": 2, "email": "a@example.com", "website_id": 1},
        {"id": 3, "email": "a@example.com", "website_id": 2},
    ]
    result = group_duplicate_email_clusters(customers)
    assert len(result) == 1
    assert result[0]["websiteIds"] == [1, 2, 3]
    assert sorted(result[0]["customerIds"]) == [1, 2, 3]
