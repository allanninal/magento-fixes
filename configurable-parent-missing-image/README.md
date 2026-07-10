# Configurable parent has no image while children do

A Magento 2 configurable product's own `catalog_product_entity_media_gallery_value_to_entity` linkage is entirely independent of its simple children's gallery entries. Magento never auto-copies or inherits images from children to the parent row. This commonly appears after CSV or API bulk imports, or product creation flows, where images are attached only to the simple SKUs. The storefront often masks this by falling back to a child's image through `ImageBuilder` and the configurable JavaScript widget, so the gap only surfaces when an API consumer, a PWA, a marketplace feed, or a mobile app, requests the parent directly.

This script lists configurable products, reads the parent's own media gallery and every child's media gallery, and flags every parent where its own gallery has zero non-disabled entries while at least one child has more than zero.

**Full guide with diagrams:** https://www.allanninal.dev/magento/configurable-parent-missing-image/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export DRY_RUN="true"

python configurable-parent-missing-image/python/configurable_missing_image.py
node   configurable-parent-missing-image/node/configurable-missing-image.js
```

`decide_missing_parent_image` is a pure function: it takes the parent's gallery array and a map of child SKU to that child's gallery array, and returns `{flagged, parentImageCount, childrenWithImages, recommendedFixSku}`. It is flagged only when the parent's non-disabled entry count is zero and at least one child has a non-disabled entry. The recommended SKU prefers a child entry whose `types` includes `image`, falling back to the first eligible child.

This is a flag and report tool by design, not an auto-fixer. Copying a child's image onto the parent is a merchandising decision a script cannot safely guess, so `DRY_RUN=true` (the default) only reports mismatched configurables with the recommended child to review. The script does not perform the upload itself even when `DRY_RUN=false`; it logs a reminder and exposes `upload_entry_from_child` / `uploadEntryFromChild` so a person can call it deliberately once they have confirmed the file. That call issues a `POST /rest/V1/products/{sku}/media` with a new `mediaGalleryEntry`, which creates a gallery entry on the parent SKU without touching the child's own data.

## Test

```bash
pytest configurable-parent-missing-image/python
node --test configurable-parent-missing-image/node
```
