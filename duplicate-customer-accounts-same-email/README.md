# Duplicate customer accounts share one email across websites

When Customer Configuration, Account Sharing Options is set to Per Website instead of Global, Magento only enforces the unique-email rule inside a website's shared customer group. The same email address can register a separate customer `entity_id` on every website in the installation, which is fine for storefront browsing but breaks any external system, such as an ERP, CRM, or marketing platform, that keys customer records by email alone.

This script never merges or deletes anything, since merging `entity_id`s means re-pointing `sales_order`, `quote`, `wishlist`, and address rows, which is destructive and not reversible through the REST API. It pages through every customer, groups them by normalized email with a pure function, and reports any email tied to more than one `website_id`. The only allowed write, behind a dry run guard, is a non-destructive `duplicate_email_flag` custom attribute tag for manual reconciliation.

**Full guide with diagrams:** https://www.allanninal.dev/magento/duplicate-customer-accounts-same-email/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export CANONICAL_WEBSITE_ID="1"
export DRY_RUN="true"

python duplicate-customer-accounts-same-email/python/find_duplicate_email_clusters.py
node   duplicate-customer-accounts-same-email/node/find-duplicate-email-clusters.js
```

`group_duplicate_email_clusters` is a pure function: it normalizes each email (trim and lower case) as the grouping key, buckets customers by that key, and keeps only the buckets where the distinct `website_id` values number more than one, or where the same email and website pair repeats (an invalid state on its own). It never decides to merge or delete anything. The only write is a `duplicate_email_flag` custom attribute on non-canonical customers, applied one at a time, and it skips any customer already on `CANONICAL_WEBSITE_ID`. Start with `DRY_RUN=true` to review the cluster report first.

## Test

```bash
pytest duplicate-customer-accounts-same-email/python
node --test duplicate-customer-accounts-same-email/node
```
