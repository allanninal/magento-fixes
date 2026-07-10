# magento-fixes

Small, focused scripts that detect and repair the everyday problems that hit real Magento 2 and Adobe Commerce stores. Every fix ships in **both Python and Node.js**, is **safe by default** (a `DRY_RUN` flag that defaults to `true`, so it reports before it writes), and has a **pure decision function** with unit tests.

Each fix has a full write-up with diagrams on **[allanninal.dev/magento](https://www.allanninal.dev/magento/)**.

## How the scripts authenticate

The scripts talk to the Magento 2 **REST API**. Get an admin bearer token (`POST /rest/V1/integration/admin/token`) or use an integration token:

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="your admin bearer token"
export DRY_RUN="true"
```

They send `Authorization: Bearer <token>` to `/rest/V1/*` routes.

## The fixes

| Fix | What it does | Type | Guide |
| --- | --- | --- | --- |
