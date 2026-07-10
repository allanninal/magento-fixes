# URL rewrite not generated on product edit or duplicate

A product is saved through the REST API, or duplicated in the admin grid, with no error and a clean 200 OK, but no `url_rewrite` row gets written and the product URL 404s. `ProductProcessUrlRewriteSavingObserver` regenerates rewrite rows on `catalog_product_save_after` using `Product::getStoreIds()` to resolve which stores to write for. In single-store mode, and reliably when the save comes from `PUT /V1/products/{sku}` instead of the admin form, `getStoreIds()` mishandles `website_ids` and resolves the wrong or an empty store scope, so the generator silently writes nothing. A duplicated product runs through the identical save path, so it can be created with zero rewrite rows from the start.

There is no public API to insert a `url_rewrite` row directly, and a blind write risks a `URL_REWRITE_REQUEST_PATH_STORE_ID` collision with a row that already claims that path. This script never writes to `url_rewrite` directly. It reads a product's `url_key` and website scope over REST, computes the request_path it should have per store, checks the live storefront URL for a 404, and reports affected SKUs with the documented re-save workaround.

**Full guide with diagrams:** https://www.allanninal.dev/magento/url-rewrite-not-generated-on-edit/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export CHECK_SKUS="GREEN-SHIRT,BLUE-SHIRT"
export STORE_BASE_URLS="1:https://your-store.example.com"
export DRY_RUN="true"

python url-rewrite-not-generated-on-edit/python/url_rewrite_missing.py
node   url-rewrite-not-generated-on-edit/node/url-rewrite-missing.js
```

`is_url_rewrite_missing` / `isUrlRewriteMissing` is a pure function: it takes a product (sku, urlKey, storeIds), the configured URL suffix, and a pre-fetched map of store_id to known request_paths, and returns the `{sku, storeId, expectedPath}` pairs missing their expected rewrite. No network calls happen inside it, which is what makes it safe and fast to test.

With `DRY_RUN=true` (the default) the script only reports affected SKUs. With `DRY_RUN=false` it applies the documented core workaround, a `PUT /V1/products/{sku}` with `extension_attributes.website_ids` intentionally duplicated (for example `[1, 1]`), which forces `getStoreIds()` down a code path that resolves correctly. The alternative, resaving through the Admin UI or running `bin/magento indexer:reindex catalog_url_rewrite`, is CLI or admin only and is only reported, never executed by this script.

## Test

```bash
pytest url-rewrite-not-generated-on-edit/python
node --test url-rewrite-not-generated-on-edit/node
```
