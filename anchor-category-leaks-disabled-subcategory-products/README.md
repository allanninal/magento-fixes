# Anchor category shows products from disabled subcategories

Magento's `catalog_category_product` indexer builds an anchor category's product list by walking the full category subtree using the category path. It never checks each descendant's `is_active` flag while doing it. `is_anchor` only controls whether a category aggregates its subtree's products at all, it was never wired to also respect whether those subcategories are enabled. So disabling a subcategory does not remove its assigned products from the parent anchor's indexed listing, and reindexing reproduces the same leak every time because this is core aggregation logic, not a stale index.

This script walks an anchor category's subtree over `GET /rest/V1/categories`, finds every disabled descendant, reads its directly assigned SKUs from `GET /rest/V1/categories/{id}/products`, and cross-checks each SKU against `GET /rest/V1/products` to confirm it is enabled and visible, meaning it will actually leak onto the storefront's anchor listing.

**Full guide with diagrams:** https://www.allanninal.dev/magento/anchor-category-leaks-disabled-subcategory-products/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export ROOT_CATEGORY_ID="2"
export DRY_RUN="true"

python anchor-category-leaks-disabled-subcategory-products/python/anchor_leak_check.py
node   anchor-category-leaks-disabled-subcategory-products/node/anchor-leak-check.js
```

`find_leaked_anchor_products` is a pure function: given the anchor's subtree (plain `{id, isActive, isAnchor, children}` data), a product index of `sku -> {status, visibility}`, and a map of category id to its directly assigned SKUs, it walks the tree once and emits one leak record per `(anchorCategoryId, disabledCategoryId, sku)` for every SKU under a disabled descendant that is still enabled (`status === 1`) and visible (`visibility !== 1`, Not Visible Individually), deduped by SKU and anchor id. The script never changes `is_anchor` or `is_active` semantics, that logic lives in Magento core. With `DRY_RUN=true` (the default) it only reports. Setting `DRY_RUN=false` additionally calls `PUT /rest/V1/categories/{id}` with a `productLinks` array that omits the confirmed leaked SKUs, unassigning them from the disabled category only, once a human has reviewed the report.

## Test

```bash
pytest anchor-category-leaks-disabled-subcategory-products/python
node --test anchor-category-leaks-disabled-subcategory-products/node
```
