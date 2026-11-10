.PHONY: test

test:
	node --check custom_components/optim_energy/frontend/building-cards.js
	node --check custom_components/optim_energy/frontend/energy-report-card.js
	node tests/js/test_portal.js
	python3 -m compileall -q custom_components
	python3 -m unittest discover -s tests -p 'test_*.py'
