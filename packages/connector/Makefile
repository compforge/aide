.PHONY: lint test
lint:
	npm run typecheck
test:
	$(MAKE) -C ../.. test TEST_FILES="tests/connector-registry.test.ts tests/connector-packages.test.ts tests/connector-verb.test.ts"
