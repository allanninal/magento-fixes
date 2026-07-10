# Dummy environment so the scripts import cleanly during tests.
# The tests only exercise pure functions, so no real credentials are ever used.
import os

os.environ.setdefault('MAGENTO_URL', 'https://demo.example.com')
os.environ.setdefault('MAGENTO_ADMIN_TOKEN', 'token_dummy')
os.environ.setdefault('DRY_RUN', 'true')
