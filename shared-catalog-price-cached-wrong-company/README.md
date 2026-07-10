# Shared catalog price cached and served to the wrong company

Magento's full page cache and block cache key rendered price HTML on a hash of `Magento\Framework\App\Http\Context`, customer group, store, currency, carried via the `X-Magento-Vary` cookie and header. B2B shared catalogs apply a per company discount on top of the base tier price, but the cache layer does not always fully re derive that context before caching a category page's rendered price HTML (`magento/magento2` issues 10439 and 38509, and the related "wrong price after login" symptom in issue 40474; confirmed as a platform defect by Adobe quality patch ACSD-48784). The first viewer's price, often a guest or one company's buyer, gets cached and served to the next visitor from a different company or a guest until the entry is purged.

This script reads a shared catalog's assigned products and customer group, computes the authoritative tier and shared catalog price per group with `TierPriceStorageInterface` (`tier-prices-information`), simulates what guest, General, and each company's group would see, and flags any SKU/group pair where the rendered price does not match, distinguishing an exact leak of another company's price (`wrong_company`) from a generic stale cache (`wrong_group`). It never rewrites price data: the only opt in write is re-assigning the shared catalog's own products, which forces Magento to reindex and invalidate the cache tags tied to that catalog. Flushing the full page cache and Varnish itself is CLI only and is reported, not performed.

**Full guide with diagrams:** https://www.allanninal.dev/magento/shared-catalog-price-cached-wrong-company/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
# or, if you already have a token:
# export MAGENTO_ADMIN_TOKEN="..."
export SHARED_CATALOG_ID="2"
export CATEGORY_ID=""        # optional, used when SKUS and SHARED_CATALOG_ID are both empty
export SKUS="wholesale-widget-01,wholesale-widget-02"
export WEBSITE_ID="1"
export GUEST_GROUP_ID="0"
export GENERAL_GROUP_ID="1"
export PRICE_TOLERANCE="0.01"
export DRY_RUN="true"

python shared-catalog-price-cached-wrong-company/python/flag_shared_catalog_price_mismatch.py
node   shared-catalog-price-cached-wrong-company/node/flag-shared-catalog-price-mismatch.js
```

`decide_price_mismatch` / `decidePriceMismatch` is a pure function (no I/O): given an already-fetched expected price and group, an observed rendered price and group, and a map of other groups' expected prices, it returns `severity: "wrong_company"` only when the rendered price exactly matches a *different* group's expected price while the observed group differs from the expected one, the unmistakable sign of one company's price leaking to another visitor. Any other disagreement is `"wrong_group"`, a generic stale cache. A match within a cent is `"ok"`. Start with `DRY_RUN=true` to review the flagged SKU/group pairs (written to `shared_catalog_price_mismatch.csv` in Python) before enabling the shared catalog re-assign nudge, and always follow up with `bin/magento cache:clean full_page,block_html,config && bin/magento indexer:reindex catalog_product_price`, since flushing FPC and Varnish is outside REST.

## Test

```bash
pytest shared-catalog-price-cached-wrong-company/python
node --test shared-catalog-price-cached-wrong-company/node
```

Both test suites exercise only the pure decision function, no network and no Magento instance required.
