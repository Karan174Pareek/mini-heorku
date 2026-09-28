.PHONY: up down test-phase1

up:
ifeq ($(OS),Windows_NT)
	powershell -ExecutionPolicy Bypass -File infra/scripts/up.ps1
else
	./infra/scripts/up.sh
endif

down:
ifeq ($(OS),Windows_NT)
	powershell -ExecutionPolicy Bypass -File infra/scripts/down.ps1
else
	./infra/scripts/down.sh
endif

test-phase1:
ifeq ($(OS),Windows_NT)
	powershell -ExecutionPolicy Bypass -File infra/tests/verify-phase1.ps1
else
	./infra/tests/verify-phase1.sh
endif

test-phase3:
ifeq ($(OS),Windows_NT)
	powershell -ExecutionPolicy Bypass -File infra/tests/verify-phase3.ps1
else
	./infra/tests/verify-phase3.sh
endif

