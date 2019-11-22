package main

import (
	"testing"
)

func Test_Main(t *testing.T) {
	foo := hi()
	if foo != "Hello world!" {
		t.Error("fail")
	}
}
