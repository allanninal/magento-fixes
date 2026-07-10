# Automatic no coupon rule stops applying once a coupon rule exists

`Magento\SalesRule\Model\ResourceModel\Rule\Collection::setValidationFilter()` builds one query to fetch cart price rules valid for the current quote, joining `salesrule_coupon` and filtering by `coupon_type`, `sort_order` (Priority), and, once a coupon code is entered, by that code matching `rule_coupons.code`. That coupon match has historically been applied as a hard AND rather than an OR against the no-coupon rule type, so an automatic no-coupon rule is excluded from the candidate set entirely the instant a coupon rule exists and a code is entered, not merely failing its conditions. Even when both rules are fetched, a coupon rule with an equal or higher priority and `stop_rules_processing` true stops the no-coupon rule from contributing a discount. This job lists active cart price rules over the REST API and reports every no-coupon rule that is being shadowed this way. It never writes a rule change on its own.

**Full guide with diagrams:** https://www.allanninal.dev/magento/no-coupon-rule-disabled-by-coupon-rule/

## Run it

```bash
export MAGENTO_URL="https://your-store.example.com"
export MAGENTO_ADMIN_TOKEN="eyJraWQ..."
export DRY_RUN="true"

python no-coupon-rule-disabled-by-coupon-rule/python/find_shadowed_no_coupon_rules.py
node   no-coupon-rule-disabled-by-coupon-rule/node/find-shadowed-no-coupon-rules.js
```

`find_shadowed_no_coupon_rules` is a pure function: it splits active rules into no-coupon and coupon groups, and for every pair that shares at least one website and one customer group, flags a shadow when the coupon rule's `sort_order` is equal to or lower in number than the no-coupon rule's and `stop_rules_processing` is true. By default the script only reports each shadowed pair with the current `sort_order` and `stop_rules_processing` values.

The only additional output, gated behind `DRY_RUN=false`, prints (and never executes) the exact `PUT /rest/V1/salesRules/{rule_id}` payload that would lower the coupon rule's `sort_order` below the automatic rule's or set `stop_rules_processing` to false, as a diff for manual review. Writing a priority or Discard Subsequent Rules change is a merchant decision about live pricing, so this script never applies it automatically, the same way the known community workaround overrides `setValidationFilter` in a module rather than patching production rule data directly.

Start with `DRY_RUN=true` to review the list first.

## Test

```bash
pytest no-coupon-rule-disabled-by-coupon-rule/python
node --test no-coupon-rule-disabled-by-coupon-rule/node
```
