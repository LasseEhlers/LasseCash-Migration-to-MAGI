module github.com/lassecash/node

go 1.24.0

toolchain go1.24.13

require (
	contract-template v0.0.0
	github.com/lassecash/engine v0.0.0
)

replace github.com/lassecash/engine => ../engine

replace contract-template => ../contract
