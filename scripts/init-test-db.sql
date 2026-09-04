-- Runs once, the first time the postgres container initialises its data
-- directory. The development database comes from POSTGRES_DB; this adds the
-- separate database the test suite requires.
CREATE DATABASE invoice_processor_test OWNER invoice;
