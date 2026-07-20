# FoxyBear CLI — packages/opencode
#
# Convention: `make <command> <arg>`. One target per command; arguments are
# parsed from MAKECMDGOALS, never split into per-variant targets.

.PHONY: sdd
# SDD pipeline — code-enforced Spec-Driven-Development gate.
#   make sdd status
#   make sdd author
#   make sdd audit
#   make sdd gate [yes]
#   make sdd tests sdd-01
#   make sdd implement sdd-01
#   make sdd verify sdd-01
#   make sdd reset
sdd:
	@bun run script/sdd/sdd.ts $(filter-out sdd,$(MAKECMDGOALS))

# Swallow the argument words so make doesn't treat them as targets.
%:
	@:
