# Product URL fails when rewrite generation is disabled with empty suffix

With `catalog/seo/product_url_suffix` and `catalog/seo/category_url_suffix` both empty, `catalog/seo/product_use_categories` set to Yes, and `catalog/seo/generate_category_product_rewrites` set to No, Magento resolves product URLs on the fly with `Magento\CatalogUrlRewrite\Model\Storage\DynamicStorage` instead of reading a precomputed `url_rewrite` row. That class strips the product's `url_key` off the end of the full request path with a plain `str_replace` instead of a suffix-anchored `substr`. Without a suffix to anchor on, it can strip the wrong occurrence or fail to isolate the category path, so the category lookup fails and the request 404s (Magento 2.4.3+) or throws a 500 (earlier versions) instead of rendering the product.

This is a store configuration risk, not corrupt catalog data. `store/storeConfigs` exposes the two suffix fields but not `generate_category_product_rewrites` or `product_use_categories`, so this script reads the suffix config per store, samples products assigned to non-root categories, resolves each product's live storefront URL, and flags it as affected only when both suffixes are empty and the live HTTP GET actually returns 404 or 500 for a path containing a category segment.

**Full guide with diagrams:** https://www.allanninal.dev/magento/disabled-rewrite-empty-suffix-error/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export SAMPLE_PAGE_SIZE="100"
export SAMPLE_MAX_PAGES="5"
export DRY_RUN="true"

python disabled-rewrite-empty-suffix-error/python/url_suffix_risk_check.py
node   disabled-rewrite-empty-suffix-error/node/url-suffix-risk-check.js
```

`classify_url_suffix_risk` (Python) and `classifyUrlSuffixRisk` (Node) are pure functions that take the four config values, a resolved request path, and an observed HTTP status, and return whether that product is affected, so the decision is fully testable without a network call. This is a store-configuration defect, not corrupt data, so the script never auto-writes the fix. It prints the exact CLI commands, `bin/magento config:set catalog/seo/product_url_suffix html --scope=stores --scope-code={code}` followed by `bin/magento indexer:reindex catalog_url_rewrite` (or enabling `generate_category_product_rewrites`), and only PUTs a product's `url_key` for a specific SKU as a narrow REST-only mitigation when `DRY_RUN=false` and a human has confirmed the SKU list.

## Test

```bash
pytest disabled-rewrite-empty-suffix-error/python
node --test disabled-rewrite-empty-suffix-error/node
```
