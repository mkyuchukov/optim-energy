.PHONY: test test-js test-python test-runtime test-scale test-browser

test: test-js test-python

test-js:
	node --check custom_components/optim_energy/frontend/building-cards.js
	node --check custom_components/optim_energy/frontend/energy-report-card.js
	node tests/js/test_portal.js

test-python:
	python3 -m compileall -q custom_components
	python3 -m unittest discover -s tests -p 'test_*.py'

test-runtime:
	python3 tests/runtime/acceptance.py

test-scale:
	python3 tests/runtime/scale_acceptance.py

test-browser:
	python3 tests/runtime/browser_acceptance.py
