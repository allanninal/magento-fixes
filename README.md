# Magento 2 Fixes

Small, tested Python and Node.js scripts that detect and repair real problems on **Magento 2** stores. Stale and stuck indexers, cron that silently stops, MSI salable-quantity corruption and oversell, order grid desync, invoice and credit memo errors, catalog and cart price rule bugs, URL rewrite 404s, and website assignment gaps.

Every fix is safe by default. The scripts start in a dry run mode that reports what they would do, so you can read the plan before anything writes.

By **[Allan Niñal](https://github.com/allanninal)** — AI Solutions Engineer. I build AI powered tools, data products, and AWS automation.
Full write ups with diagrams for each fix live at **[allanninal.dev/magento](https://www.allanninal.dev/magento/)**.

[![Follow on GitHub](https://img.shields.io/github/followers/allanninal?label=Follow%20%40allanninal&style=social)](https://github.com/allanninal)
[![Tests](https://github.com/allanninal/magento-fixes/actions/workflows/tests.yml/badge.svg)](https://github.com/allanninal/magento-fixes/actions/workflows/tests.yml)

## How the scripts work

The scripts talk to the **Magento 2 REST API**. They get an admin bearer token from `POST /rest/V1/integration/admin/token`, then call `/rest/V1/*` routes with `searchCriteria` filters. Node uses the built-in `fetch`; Python uses `requests`. The decision logic in every fix is a pure function with no I/O, so it is unit tested.

## Setup

Set the environment variables a fix needs. Use an admin user's credentials or an integration access token.

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export DRY_RUN="true"   # start safe
```

Python needs `pip install requests pytest`. Node needs Node 18 or newer (the scripts use the built-in `fetch`, no packages).

## The fixes

| Fix | What it does | Type | Guide |
|---|---|---|---|
| [stale-price-index-wrong-prices](./stale-price-index-wrong-prices/) | Storefront price lags admin price after edits or rule changes. Script diffs API price vs price index and triggers reindex. | Diagnostic | [Read](https://www.allanninal.dev/magento/stale-price-index-wrong-prices/) |
| [indexer-stuck-reindex-required](./indexer-stuck-reindex-required/) | A crashed or killed reindex leaves indexer_state locked forever. Script polls indexer status and flags or resets stuck rows. | Diagnostic | [Read](https://www.allanninal.dev/magento/indexer-stuck-reindex-required/) |
| [products-vanish-during-price-reindex](./products-vanish-during-price-reindex/) | catalog_product_index_price briefly drops rows during rebuild, hiding products. Script compares product counts before and after reindex. | Diagnostic | [Read](https://www.allanninal.dev/magento/products-vanish-during-price-reindex/) |
| [products-flap-during-scheduled-indexing](./products-flap-during-scheduled-indexing/) | Mview delete and recreate cycle temporarily empties catalogsearch results. Script polls category and search endpoints during reindex windows. | Diagnostic | [Read](https://www.allanninal.dev/magento/products-flap-during-scheduled-indexing/) |
| [category-assignment-missing-from-search-index](./category-assignment-missing-from-search-index/) | catalog_category_product edits never flow into the fulltext changelog, hiding newly assigned products. Script compares category API assignment vs storefront listing. | Diagnostic | [Read](https://www.allanninal.dev/magento/category-assignment-missing-from-search-index/) |
| [category-product-count-wrong](./category-product-count-wrong/) | Reported category product count diverges from real assignments due to a temp table bug. Script compares actual assignments vs reported count via API. | Diagnostic | [Read](https://www.allanninal.dev/magento/category-product-count-wrong/) |
| [anchor-category-leaks-disabled-subcategory-products](./anchor-category-leaks-disabled-subcategory-products/) | is_anchor categories leak products from disabled child categories into storefront listings. Script cross-checks category status vs indexed product assignment. | Diagnostic | [Read](https://www.allanninal.dev/magento/anchor-category-leaks-disabled-subcategory-products/) |
| [catalog-price-rule-cron-blocks-indexers](./catalog-price-rule-cron-blocks-indexers/) | catalogrule_apply_all failing on a new store view halts scheduled indexers, leaving rule prices unapplied. Script compares catalog rule price vs expected discount via API. | Diagnostic | [Read](https://www.allanninal.dev/magento/catalog-price-rule-cron-blocks-indexers/) |
| [cron-stuck-running-blocks-jobs](./cron-stuck-running-blocks-jobs/) | A crashed job leaves cron_schedule status as running forever, starving the job code. Script queries cron_schedule for stale running rows past a timeout. | Diagnostic | [Read](https://www.allanninal.dev/magento/cron-stuck-running-blocks-jobs/) |
| [cron-generation-halts-after-crash](./cron-generation-halts-after-crash/) | After one crashed run, cron stops scheduling new jobs for that code. Script checks last run timestamp per job against expected frequency. | Diagnostic | [Read](https://www.allanninal.dev/magento/cron-generation-halts-after-crash/) |
| [cron-schedule-duplicate-pending-jobs](./cron-schedule-duplicate-pending-jobs/) | Duplicate pending rows for the same job pile up and delay real work. Script counts duplicate pending schedules per job code and prunes them. | Repair | [Read](https://www.allanninal.dev/magento/cron-schedule-duplicate-pending-jobs/) |
| [order-emails-not-sent-cron-dependency](./order-emails-not-sent-cron-dependency/) | Async sales email depends on cron; if cron is dead, order emails never go out though orders succeed. Script checks cron health against an unsent email queue. | Diagnostic | [Read](https://www.allanninal.dev/magento/order-emails-not-sent-cron-dependency/) |
| [salable-quantity-corrupted-by-reservations](./salable-quantity-corrupted-by-reservations/) | Lost, duplicated, or overcompensated reservations desync salable qty from real stock. Script sums reservations vs source qty per SKU and reconciles. | Reconciler | [Read](https://www.allanninal.dev/magento/salable-quantity-corrupted-by-reservations/) |
| [salable-quantity-negative-oversell](./salable-quantity-negative-oversell/) | Concurrent checkout or bad backorder config lets salable qty drop below zero. Script cross-checks source_items, reservations, and open orders for negative stock. | Diagnostic | [Read](https://www.allanninal.dev/magento/salable-quantity-negative-oversell/) |
| [in-stock-flag-disagrees-with-zero-salable-qty](./in-stock-flag-disagrees-with-zero-salable-qty/) | Stock status flag disagrees with computed salable qty of zero, letting shoppers order phantom stock. Script compares stock item status vs salable quantity API. | Diagnostic | [Read](https://www.allanninal.dev/magento/in-stock-flag-disagrees-with-zero-salable-qty/) |
| [listing-vs-detail-stock-status-mismatch](./listing-vs-detail-stock-status-mismatch/) | Category grid shows in stock while the product page shows out of stock for the same SKU at zero qty. Script diffs stock status across grid and detail endpoints. | Diagnostic | [Read](https://www.allanninal.dev/magento/listing-vs-detail-stock-status-mismatch/) |
| [shared-stock-not-synced-across-websites](./shared-stock-not-synced-across-websites/) | A purchase in one website does not decrement salable qty for sibling websites sharing the same stock, causing oversell. Script compares salable totals per website for a stock id. | Diagnostic | [Read](https://www.allanninal.dev/magento/shared-stock-not-synced-across-websites/) |
| [configurable-parent-stock-status-not-synced](./configurable-parent-stock-status-not-synced/) | Parent configurable stays stale or wrong after child simple product qty changes, sometimes showing in stock when all children are out. Script recomputes parent status from children via API. | Reconciler | [Read](https://www.allanninal.dev/magento/configurable-parent-stock-status-not-synced/) |
| [threshold-change-not-applied-existing-items](./threshold-change-not-applied-existing-items/) | Changing the out of stock threshold does not recompute status for existing source items. Script recalculates is_in_stock per source item against the new threshold. | Repair | [Read](https://www.allanninal.dev/magento/threshold-change-not-applied-existing-items/) |
| [negative-source-item-counted-as-positive](./negative-source-item-counted-as-positive/) | An out of stock source with negative qty still adds positively to combined salable quantity. Script sums source_items per SKU and flags impossible totals. | Diagnostic | [Read](https://www.allanninal.dev/magento/negative-source-item-counted-as-positive/) |
| [rest-orders-skip-reservation-placement](./rest-orders-skip-reservation-placement/) | Orders placed through the order create API bypass the reservation plugin, leaving salable qty stale. Script compares order items against the reservations table. | Diagnostic | [Read](https://www.allanninal.dev/magento/rest-orders-skip-reservation-placement/) |
| [sales-order-grid-out-of-sync](./sales-order-grid-out-of-sync/) | Async grid indexing watermark race or crash leaves orders missing or stale in the admin grid. Script diffs order ids and status between the entity API and grid API. | Reconciler | [Read](https://www.allanninal.dev/magento/sales-order-grid-out-of-sync/) |
| [grid-refresh-batch-size-backlog](./grid-refresh-batch-size-backlog/) | Scheduled grid refresh only processes one batch per run so unsynced orders pile up. Script counts pending sync rows and triggers repeated refresh. | Diagnostic | [Read](https://www.allanninal.dev/magento/grid-refresh-batch-size-backlog/) |
| [duplicate-order-increment-id](./duplicate-order-increment-id/) | Two orders share the same increment id after migration or store padding differences, breaking lookups and ERP sync. Script scans orders for duplicate increment id values. | Diagnostic | [Read](https://www.allanninal.dev/magento/duplicate-order-increment-id/) |
| [order-sequence-drift-after-migration](./order-sequence-drift-after-migration/) | The sequence table falls out of sync with the underlying auto increment, causing repeated or gapped order numbers. Script compares max increment id vs sequence value. | Diagnostic | [Read](https://www.allanninal.dev/magento/order-sequence-drift-after-migration/) |
| [reserved-order-id-numbering-gaps](./reserved-order-id-numbering-gaps/) | Abandoned quotes reserve an increment id that is never consumed, looking like lost orders. Script correlates quote reserved_order_id against placed orders. | Reconciler | [Read](https://www.allanninal.dev/magento/reserved-order-id-numbering-gaps/) |
| [order-stuck-pending-payment-after-invoice](./order-stuck-pending-payment-after-invoice/) | Invoice or gateway shows paid but order state never transitions to processing. Script fetches order and invoice status via API and flags the mismatch. | Diagnostic | [Read](https://www.allanninal.dev/magento/order-stuck-pending-payment-after-invoice/) |
| [order-closed-with-pending-invoice](./order-closed-with-pending-invoice/) | Creating a shipment flips the order to closed even though the invoice has not been paid. Script cross-checks order status vs invoice state on shipped orders. | Diagnostic | [Read](https://www.allanninal.dev/magento/order-closed-with-pending-invoice/) |
| [order-stuck-in-payment-review](./order-stuck-in-payment-review/) | A gateway review flag freezes the order state indefinitely with no cancel path. Script finds orders in payment review older than a threshold and forces cancel or recheck. | Reconciler | [Read](https://www.allanninal.dev/magento/order-stuck-in-payment-review/) |
| [credit-memo-total-wrong-multi-invoice](./credit-memo-total-wrong-multi-invoice/) | Refund total or tax is miscalculated when an order was split across multiple invoices. Script recomputes expected refund from invoice and tax data and compares to the credit memo. | Diagnostic | [Read](https://www.allanninal.dev/magento/credit-memo-total-wrong-multi-invoice/) |
| [partial-refund-tax-miscalculated](./partial-refund-tax-miscalculated/) | Partial credit memos pull total order tax rather than a proportional share. Script recomputes expected tax and compares to the credit memo record. | Diagnostic | [Read](https://www.allanninal.dev/magento/partial-refund-tax-miscalculated/) |
| [duplicate-credit-memo-created](./duplicate-credit-memo-created/) | A single refund action produces more than one credit memo record. Script lists credit memos per order id and flags extras. | Diagnostic | [Read](https://www.allanninal.dev/magento/duplicate-credit-memo-created/) |
| [order-status-wrong-after-refund](./order-status-wrong-after-refund/) | A partial or zero total credit memo leaves the order at Complete or Processing instead of Closed. Script checks credit memo totals against order status. | Diagnostic | [Read](https://www.allanninal.dev/magento/order-status-wrong-after-refund/) |
| [credit-memo-total-not-refreshed](./credit-memo-total-not-refreshed/) | Editing refund shipping or adjustment fields does not refresh the credit memo grand total in the API response. Script recomputes expected total from line items and flags drift. | Diagnostic | [Read](https://www.allanninal.dev/magento/credit-memo-total-not-refreshed/) |
| [online-refund-falls-back-offline](./online-refund-falls-back-offline/) | A REST created credit memo fails to load the invoice instance so the gateway is never charged the refund. Script checks the credit memo online flag and transaction id against the request. | Diagnostic | [Read](https://www.allanninal.dev/magento/online-refund-falls-back-offline/) |
| [manual-invoice-missing-tax](./manual-invoice-missing-tax/) | Admin created invoices omit tax amount so total paid understates and the order shows a balance due. Script sums invoices vs order grand total via API. | Diagnostic | [Read](https://www.allanninal.dev/magento/manual-invoice-missing-tax/) |
| [shipment-tracking-dropped-via-api](./shipment-tracking-dropped-via-api/) | A shipment created through the ship endpoint saves without its tracking number attached. Script creates or reads shipments and checks the tracks collection for the missing entry. | Diagnostic | [Read](https://www.allanninal.dev/magento/shipment-tracking-dropped-via-api/) |
| [duplicate-url-rewrite-rows-404](./duplicate-url-rewrite-rows-404/) | Migration or bulk edits leave duplicate or stale url_rewrite entries pointing nowhere. Script fetches URL keys via API and diffs against url_rewrite records. | Reconciler | [Read](https://www.allanninal.dev/magento/duplicate-url-rewrite-rows-404/) |
| [disabled-rewrite-empty-suffix-error](./disabled-rewrite-empty-suffix-error/) | Disabling category and product rewrite generation combined with an empty suffix causes 404 or 500 on product pages. Script checks SEO config flags against live product URL responses. | Diagnostic | [Read](https://www.allanninal.dev/magento/disabled-rewrite-empty-suffix-error/) |
| [url-rewrite-not-generated-on-edit](./url-rewrite-not-generated-on-edit/) | Editing or duplicating a product silently skips rewrite generation, causing 404s. Script fetches the product then checks the url rewrite endpoint for a match. | Diagnostic | [Read](https://www.allanninal.dev/magento/url-rewrite-not-generated-on-edit/) |
| [disabled-rewrite-setting-still-duplicates](./disabled-rewrite-setting-still-duplicates/) | Setting category and product rewrite generation to no still yields two rewrite paths per product. Script lists url_rewrite entries per product id looking for duplicates. | Diagnostic | [Read](https://www.allanninal.dev/magento/disabled-rewrite-setting-still-duplicates/) |
| [duplicate-url-key-blocks-resave](./duplicate-url-key-blocks-resave/) | A collision error blocks edits when two products end up with the same request path after a platform migration. Script finds colliding request path rows and dedupes them. | Reconciler | [Read](https://www.allanninal.dev/magento/duplicate-url-key-blocks-resave/) |
| [enabled-product-missing-from-storefront](./enabled-product-missing-from-storefront/) | Product has active status but wrong visibility, website assignment, or stale index keeps it off the storefront. Script checks status, visibility, website assignment, and category link via API against storefront presence. | Diagnostic | [Read](https://www.allanninal.dev/magento/enabled-product-missing-from-storefront/) |
| [product-force-assigned-wrong-store](./product-force-assigned-wrong-store/) | Products lose their website assignment and get force assigned to the default store after a save. Script audits website ids via API against the expected mapping. | Diagnostic | [Read](https://www.allanninal.dev/magento/product-force-assigned-wrong-store/) |
| [imported-products-missing-website-assignment](./imported-products-missing-website-assignment/) | Products save via import or API but get no website assignment row, so they never render on the storefront. Script lists products via API and checks for empty website ids. | Diagnostic | [Read](https://www.allanninal.dev/magento/imported-products-missing-website-assignment/) |
| [duplicate-sku-race-condition](./duplicate-sku-race-condition/) | A race condition during concurrent product saves creates two entities effectively duplicating one SKU. Script queries products by SKU for entity id collisions. | Reconciler | [Read](https://www.allanninal.dev/magento/duplicate-sku-race-condition/) |
| [configurable-parent-missing-image](./configurable-parent-missing-image/) | The parent configurable lacks its own gallery entry so its image is blank though variants have images. Script fetches child media gallery entries via API and flags parents with zero images. | Diagnostic | [Read](https://www.allanninal.dev/magento/configurable-parent-missing-image/) |
| [product-images-duplicated-on-import](./product-images-duplicated-on-import/) | Re-importing the same CSV or duplicating a product re-adds identical images to the gallery each run. Script counts gallery entries per SKU and flags exact duplicate files. | Diagnostic | [Read](https://www.allanninal.dev/magento/product-images-duplicated-on-import/) |
| [catalog-price-rule-wrong-base-price](./catalog-price-rule-wrong-base-price/) | A rule scoped to one customer group discounts the original price rather than that group tier price, or applies outside its scope. Script compares rule applied price vs expected group price via API. | Diagnostic | [Read](https://www.allanninal.dev/magento/catalog-price-rule-wrong-base-price/) |
| [wrong-tax-price-per-customer-group](./wrong-tax-price-per-customer-group/) | Mismatched tax class produces a different final price across customer groups for the same tier price. Script fetches price per customer group via API and compares to expected output. | Diagnostic | [Read](https://www.allanninal.dev/magento/wrong-tax-price-per-customer-group/) |
| [tax-rate-wrong-for-shipping-address](./tax-rate-wrong-for-shipping-address/) | Order applies the customer default address tax class instead of the selected shipping address, over or under charging VAT. Script recomputes expected tax rule match per address and compares to applied tax. | Reconciler | [Read](https://www.allanninal.dev/magento/tax-rate-wrong-for-shipping-address/) |
| [tax-wrong-after-coupon-applied](./tax-wrong-after-coupon-applied/) | Applying a discount coupon shifts the taxable base incorrectly so totals do not reconcile with price minus discount. Script recomputes tax from order items and discounts and diffs the result. | Diagnostic | [Read](https://www.allanninal.dev/magento/tax-wrong-after-coupon-applied/) |
| [tax-rounding-drift](./tax-rounding-drift/) | Per item vs per row tax rounding produces a small drift from the expected total. Script recomputes expected tax and diffs against the order tax amount. | Diagnostic | [Read](https://www.allanninal.dev/magento/tax-rounding-drift/) |
| [shared-catalog-price-cached-wrong-company](./shared-catalog-price-cached-wrong-company/) | The first viewer's discounted shared catalog price gets cached and served to guests or other companies on category pages. Script requests category prices as different customer groups and flags mismatches. | Diagnostic | [Read](https://www.allanninal.dev/magento/shared-catalog-price-cached-wrong-company/) |
| [coupon-usage-limit-not-enforced](./coupon-usage-limit-not-enforced/) | Uses per coupon or per customer limits fail to block extra redemptions because times_used never increments. Script counts orders per coupon and customer against configured limits. | Diagnostic | [Read](https://www.allanninal.dev/magento/coupon-usage-limit-not-enforced/) |
| [coupon-marked-used-without-order](./coupon-marked-used-without-order/) | Usage is recorded even though the cart later fails minimum order validation and never converts to an order. Script reconciles coupon usage rows against actual placed orders. | Reconciler | [Read](https://www.allanninal.dev/magento/coupon-marked-used-without-order/) |
| [no-coupon-rule-disabled-by-coupon-rule](./no-coupon-rule-disabled-by-coupon-rule/) | Adding a second coupon based rule silently disables an existing automatic no coupon rule. Script fetches active cart rules and simulates cart totals to detect non-application. | Diagnostic | [Read](https://www.allanninal.dev/magento/no-coupon-rule-disabled-by-coupon-rule/) |
| [duplicate-customer-accounts-same-email](./duplicate-customer-accounts-same-email/) | Customer account share settings allow the same email to exist per website, causing ERP or sync conflicts. Script queries customers by email across websites for duplicates. | Reconciler | [Read](https://www.allanninal.dev/magento/duplicate-customer-accounts-same-email/) |
| [admin-token-expiry-breaks-automation](./admin-token-expiry-breaks-automation/) | Hardcoded short lived admin tokens expire, causing scripted API calls to fail with unauthorized errors. Script detects 401 responses and auto refreshes via the integration OAuth token. | Diagnostic | [Read](https://www.allanninal.dev/magento/admin-token-expiry-breaks-automation/) |

More fixes land as the guides are published. Watch or star the repo to follow along.

## Running the tests

The decision logic in every fix is a pure function with no network calls, so the tests run anywhere.

```bash
# Python
pip install pytest
pytest

# Node
node --test
```

## A note on safety

These scripts can change orders, inventory, prices, and issue refunds. Always run with `DRY_RUN=true` first, read the output, and confirm it is correct before you let a script write. Test against a staging store when you can.

## Work with me

Fighting a Magento 2 bug you would rather hand off? That is what I do.

- GitHub: [github.com/allanninal](https://github.com/allanninal)
- LinkedIn: [in/allanninal](https://www.linkedin.com/in/allanninal/)
- Support the work: [ko-fi.com/allanninal](https://ko-fi.com/allanninal)

## License

MIT. Use it, change it, ship it.
