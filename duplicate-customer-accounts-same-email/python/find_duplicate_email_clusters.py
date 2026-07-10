"""Find Magento customer accounts that share one email across websites.

When Customer Configuration, Account Sharing Options is set to Per Website,
Magento only enforces the unique-email rule inside a website's shared customer
group. The same email can register a separate customer entity_id on every
website, which is fine for storefront browsing but breaks any external system
that keys customer records by email alone.

This script never merges or deletes anything, since merging entity_ids means
re-pointing sales_order, quote, wishlist, and address rows, which is destructive
and not reversible through the REST API. By default it only reports clusters.
It tags each non-canonical customer with a duplicate_email_flag custom
attribute only when DRY_RUN is false, one customer at a time.

Guide: https://www.allanninal.dev/magento/duplicate-customer-accounts-same-email/
"""
import os
import logging
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("find_duplicate_email_clusters")

MAGENTO_URL = os.environ["MAGENTO_URL"].rstrip("/")
TOKEN = os.environ["MAGENTO_ADMIN_TOKEN"]
CANONICAL_WEBSITE_ID = int(os.environ.get("CANONICAL_WEBSITE_ID", "1"))
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

PAGE_SIZE = 100


def get(path, params=None):
    r = requests.get(
        f"{MAGENTO_URL}/rest/V1{path}",
        params=params or {},
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def put(path, body):
    r = requests.put(
        f"{MAGENTO_URL}/rest/V1{path}",
        json=body,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def all_customers():
    customers, page = [], 1
    while True:
        params = {
            "searchCriteria[pageSize]": PAGE_SIZE,
            "searchCriteria[currentPage]": page,
        }
        data = get("/customers/search", params)
        items = data.get("items", [])
        for item in items:
            customers.append({
                "id": item.get("id"),
                "email": item.get("email"),
                "website_id": item.get("website_id"),
            })
        if len(items) < PAGE_SIZE:
            return customers
        page += 1


def group_duplicate_email_clusters(customers):
    """Pure function. Groups customers by normalized email and returns one
    cluster record per email that spans more than one website_id, or that has
    more than one customer on the very same website (a data integrity issue
    on its own). No I/O, fully unit-testable with in-memory arrays.
    """
    buckets = {}
    for customer in customers:
        key = (customer.get("email") or "").strip().lower()
        buckets.setdefault(key, []).append(customer)

    clusters = []
    for email, bucket in buckets.items():
        if not email:
            continue
        website_ids = sorted({c.get("website_id") for c in bucket})
        is_multi_website = len(website_ids) > 1
        is_same_website_dupe = len(website_ids) == 1 and len(bucket) > 1
        if is_multi_website or is_same_website_dupe:
            clusters.append({
                "email": email,
                "websiteIds": website_ids,
                "customerIds": [c.get("id") for c in bucket],
            })
    return clusters


def report_cluster(cluster):
    log.warning(
        "Duplicate identity cluster: email=%s customerIds=%s websiteIds=%s",
        cluster["email"], cluster["customerIds"], cluster["websiteIds"],
    )


def flag_customer(customer_id):
    body = {
        "customer": {
            "id": customer_id,
            "custom_attributes": [{"attribute_code": "duplicate_email_flag", "value": "true"}],
        }
    }
    put(f"/customers/{customer_id}", body)


def customer_website(customer_id, customers_by_id):
    customer = customers_by_id.get(customer_id)
    return customer.get("website_id") if customer else None


def run():
    customers = all_customers()
    customers_by_id = {c["id"]: c for c in customers}
    clusters = group_duplicate_email_clusters(customers)

    if not clusters:
        log.info("Done. No duplicate-identity clusters found out of %d customer(s) checked.", len(customers))
        return

    for cluster in clusters:
        report_cluster(cluster)

    if DRY_RUN:
        log.info(
            "Done. %d duplicate-identity cluster(s) found. Set DRY_RUN=false to tag non-canonical "
            "customers with duplicate_email_flag for manual reconciliation.", len(clusters),
        )
        return

    tagged = 0
    for cluster in clusters:
        for customer_id in cluster["customerIds"]:
            if customer_website(customer_id, customers_by_id) == CANONICAL_WEBSITE_ID:
                continue
            flag_customer(customer_id)
            tagged += 1
    log.info("Done. %d duplicate-identity cluster(s) found, %d customer(s) tagged for reconciliation.", len(clusters), tagged)


if __name__ == "__main__":
    run()
