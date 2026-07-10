# Wrong tax or price shown per customer group at checkout

Magento 2 and Adobe Commerce resolve tax through a Tax Rule that maps a customer tax class plus a product tax class plus a region to a rate, while each customer group is separately mapped to exactly one customer tax class under Stores, Customer Groups. When a merchant adds a new group, such as Wholesale, but never assigns it the intended customer tax class, or never adds that class to the applicable Tax Rule, the group silently falls back to a different rate than intended. Two customer groups with the identical tier price then end up with different tax and different final totals at checkout, with no error anywhere.

This script reads a product's tier prices and product tax class, every referenced customer group's tax class, the Tax Rules and rates over the REST API, computes the expected final price per group with a pure decision function, and reports any group whose computed number disagrees with the actual price or whose tax class has no matching rule at all (an orphaned group). Deciding which tax class a group should have is a business decision, so this script reports by default and only performs the one safe write, correcting an orphaned group's tax class, when an operator explicitly opts in and the fix is unambiguous.

**Full guide with diagrams:** https://www.allanninal.dev/magento/wrong-tax-price-per-customer-group/

## Run it

```bash
export MAGENTO_URL="https://yourstore.example.com"
export MAGENTO_ADMIN_USERNAME="admin"
export MAGENTO_ADMIN_PASSWORD="change-me"
# or, if you already have a token:
# export MAGENTO_ADMIN_TOKEN="..."
export SKUS="wholesale-widget-01,wholesale-widget-02"
export PRICE_EPSILON="0.01"
export DRY_RUN="true"

python wrong-tax-price-per-customer-group/python/flag_tax_price_mismatch.py
node   wrong-tax-price-per-customer-group/node/flag-tax-price-mismatch.js
```

`decide_expected_final_price` / `decideExpectedFinalPrice` is a pure function (no I/O): given an already-fetched tier price, the product's tax class id, a customer group's tax class id, the list of tax rules, a map of rate id to percentage, and whether the store's price already includes tax, it finds the rule(s) whose `customerTaxClassIds` and `productTaxClassIds` both cover the pair, sums the matching rates the way Magento stacks simultaneous rates, and returns the expected final price. If no rule matches, it returns `matchedRuleFound: false` and `appliedRatePct: 0`, which is itself the anomaly to flag (an orphaned customer group). Start with `DRY_RUN=true` to review the flagged SKU/group pairs (written to `tax_price_mismatch.csv` in Python) before enabling any write.

## Test

```bash
pytest wrong-tax-price-per-customer-group/python
node --test wrong-tax-price-per-customer-group/node
```

Both test suites exercise only the pure decision function, no network and no Magento instance required, covering the matched-rule, no-rule (orphaned group), and multi-rate-stacking cases.
