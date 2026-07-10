# Product images duplicated on repeated import or product duplication

Magento's catalog importer (`Magento\CatalogImportExport\Model\Import\Product`) and the product Copier (`Magento\Catalog\Model\Product\Copier::copy`) both append to `catalog_product_entity_media_gallery` instead of checking whether an identical image is already attached to the SKU. Re-running an import, or duplicating a product, saves a renamed copy of the same file (`image_1.jpg`, `image_2.jpg`, ...) and inserts a fresh gallery row for it every time. This script reads `media_gallery_entries` per SKU over REST, hashes the bytes each entry's file resolves to, and groups entries by that hash so only byte-identical images are treated as duplicates.

**Full guide with diagrams:** https://www.allanninal.dev/magento/product-images-duplicated-on-import/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export SKUS="MB01-BLUE,MB01-RED,MB02-BLACK"
export DRY_RUN="true"

python product-images-duplicated-on-import/python/find_duplicate_gallery_entries.py
node   product-images-duplicated-on-import/node/find-duplicate-gallery-entries.js
```

`find_duplicate_gallery_entries` is a pure function: it groups pre-fetched gallery entries by content hash (falling back to a normalized filename when a hash is unavailable) and, within each group, keeps the lowest id (the first-imported entry) as canonical while reporting the rest as duplicate candidates. A second pure function, `safe_duplicate_ids`, filters those candidates down to ones safe to remove, never a product's only image, and never a `base`/`small_image`/`thumbnail` role unless the kept entry already covers that role. The script only reports by default. With `DRY_RUN=false` it removes the confirmed and safe duplicate ids by `PUT`ting the product with `media_gallery_entries` rewritten to omit them, since older Magento versions have no single-entry delete by id other than resending the full array. Start with `DRY_RUN=true` to review the report first.

## Test

```bash
pytest product-images-duplicated-on-import/python
node --test product-images-duplicated-on-import/node
```
