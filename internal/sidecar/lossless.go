package sidecar

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/Calcium-Ion/moejs/engine"
)

// maxDepth is the nesting moejs's JSON writer carries.
const maxDepth = 10000

// checkLossless reports whether v crosses JSON unchanged: null, booleans,
// strings, finite numbers other than -0, dense plain arrays and plain or
// null-prototype objects whose own properties are enumerable data properties
// with string keys, without cycles. It reads the engine's objects directly,
// so no program code runs. The error names the first problem and its path.
func checkLossless(realm *engine.Realm, v engine.Value) error {
	c := lossless{realm: realm, active: map[*engine.Object]struct{}{}}
	return c.check(v, 0)
}

type step struct {
	key   engine.PropertyKey
	index int
	array bool
}

type lossless struct {
	realm  *engine.Realm
	active map[*engine.Object]struct{}
	path   []step
}

func (c *lossless) fail(what string) error {
	var b strings.Builder
	b.WriteString("$")
	for _, s := range c.path {
		if s.array {
			fmt.Fprintf(&b, "[%d]", s.index)
		} else if name := s.key.GoString(); identifier.MatchString(name) {
			b.WriteString("." + name)
		} else {
			b.WriteString("[" + strconv.Quote(name) + "]")
		}
	}
	return fmt.Errorf("%s at %s", what, b.String())
}

func (c *lossless) check(v engine.Value, depth int) error {
	switch {
	case v.IsNull(), v.IsBool(), v.IsString():
		return nil
	case v.IsNumber():
		switch n := v.AsNumber(); {
		case math.IsNaN(n):
			return c.fail("NaN")
		case math.IsInf(n, 0):
			return c.fail("an infinite number")
		case n == 0 && math.Signbit(n):
			return c.fail("-0")
		}
		return nil
	case v.IsUndefined():
		return c.fail("undefined")
	case v.IsSymbol():
		return c.fail("a symbol")
	case v.IsBigInt():
		return c.fail("a BigInt")
	case !v.IsObject():
		return c.fail("a value with no JSON form")
	}
	o := v.AsObject()
	if o.IsCallable() {
		return c.fail("a function")
	}
	if _, ok := c.active[o]; ok {
		return c.fail("a cycle")
	}
	if depth >= maxDepth {
		return c.fail(fmt.Sprintf("nesting deeper than %d levels", maxDepth))
	}
	c.active[o] = struct{}{}
	defer delete(c.active, o)
	switch {
	case o.Class() == engine.ClassArray && o.Proto() == c.realm.ArrayPrototype:
		return c.checkArray(o, depth)
	case o.Class() == engine.ClassObject && (o.Proto() == nil || o.Proto() == c.realm.ObjectPrototype):
		return c.checkObject(o, depth)
	}
	return c.fail(describe(o))
}

func (c *lossless) checkArray(o *engine.Object, depth int) error {
	if !o.IsDenseArray() {
		return c.fail("an array with holes")
	}
	if len(o.OwnPropertyKeys()) != int(o.ArrayLength())+1 {
		return c.fail("an array with extra properties")
	}
	for i, item := range o.Elements() {
		c.path = append(c.path, step{index: i, array: true})
		if err := c.check(item, depth+1); err != nil {
			return err
		}
		c.path = c.path[:len(c.path)-1]
	}
	return nil
}

func (c *lossless) checkObject(o *engine.Object, depth int) error {
	for _, key := range o.OwnPropertyKeys() {
		c.path = append(c.path, step{key: key})
		if key.IsSymbol() {
			return c.fail("a symbol-keyed property")
		}
		desc, _ := o.GetOwnProperty(key)
		if desc.IsAccessorDescriptor() {
			return c.fail("a getter or setter")
		}
		if !desc.Enumerable() {
			return c.fail("a non-enumerable property")
		}
		if err := c.check(desc.Value, depth+1); err != nil {
			return err
		}
		c.path = c.path[:len(c.path)-1]
	}
	return nil
}

func describe(o *engine.Object) string {
	switch o.Class() {
	case engine.ClassObject:
		return "an object with a class prototype"
	case engine.ClassArray:
		return "an array with a changed prototype"
	case engine.ClassError:
		return "an Error"
	case engine.ClassProxy:
		return "a Proxy"
	case engine.ClassBoolean, engine.ClassNumber, engine.ClassString:
		return "a boxed primitive"
	case engine.ClassTypedArray:
		return "a typed array"
	}
	return "a " + o.ClassName()
}
