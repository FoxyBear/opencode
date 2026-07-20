# FoxyBear CLI — packages/opencode
#
# Convention: `make <command> <arg>`. One target per command; arguments are
# parsed from MAKECMDGOALS, never split into per-variant targets.

# The SDD pipeline is a generic, cross-project tool living at
# FoxyBearOffice/development/sdd/. This target delegates to it, hardcoding this
# project's workstream (--ws telegram), so from here you just run:
#   make sdd status
#   make sdd author | audit | gate
#   make sdd tests sdd-01 | implement sdd-01 | verify sdd-01
SDD_DRIVER := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../../../../development/sdd/sdd.ts)

.PHONY: sdd
sdd:
	@bun $(SDD_DRIVER) --ws telegram $(filter-out sdd,$(MAKECMDGOALS))

# Swallow the argument words so make doesn't treat them as targets.
%:
	@:
