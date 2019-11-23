package main

import (
	"fmt"
)

func hi() string {
	return "Hello world!"
}

func main() {
	foo := hi()
	fmt.Println(foo)
}
