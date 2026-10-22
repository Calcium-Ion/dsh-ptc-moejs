package sidecar

import (
	"unicode/utf8"
)

// truncationMarker ends a diagnostic that was cut to its budget.
const truncationMarker = "… [truncated]"

// appendJSONString appends s as a JSON string, escaped as JSON.stringify
// escapes it. Invalid UTF-8 becomes U+FFFD.
func appendJSONString(dst []byte, s string) []byte {
	const hex = "0123456789abcdef"
	dst = append(dst, '"')
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x80 {
			r, n := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && n == 1 {
				dst = append(dst, `�`...)
			} else {
				dst = append(dst, s[i:i+n]...)
			}
			i += n
			continue
		}
		switch c {
		case '"', '\\':
			dst = append(dst, '\\', c)
		case '\b':
			dst = append(dst, `\b`...)
		case '\f':
			dst = append(dst, `\f`...)
		case '\n':
			dst = append(dst, `\n`...)
		case '\r':
			dst = append(dst, `\r`...)
		case '\t':
			dst = append(dst, `\t`...)
		default:
			if c < 0x20 {
				dst = append(dst, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xf])
			} else {
				dst = append(dst, c)
			}
		}
		i++
	}
	return append(dst, '"')
}

// truncateJSONString returns the longest JSON string, at most max bytes with
// its quotes, that is a prefix of the JSON string s. It cuts between escapes
// and characters, never inside one.
func truncateJSONString(s []byte, max int) []byte {
	if len(s) <= max {
		return s
	}
	if max < 2 {
		return nil
	}
	inner := s[1 : len(s)-1]
	end := 0
	for end < len(inner) {
		n := 1
		switch c := inner[end]; {
		case c == '\\' && end+1 < len(inner) && inner[end+1] == 'u':
			n = 6
		case c == '\\':
			n = 2
		case c >= 0x80:
			_, n = utf8.DecodeRune(inner[end:])
		}
		if end+n+2 > max {
			break
		}
		end += n
	}
	out := make([]byte, 0, end+2)
	out = append(out, '"')
	out = append(out, inner[:end]...)
	return append(out, '"')
}

// capMessage encodes a diagnostic as a JSON string of at most max bytes, or
// as the marker alone when max is smaller than the marker.
func capMessage(message string, max int) []byte {
	cut := false
	// Every byte encodes to at least one byte, so a longer prefix cannot fit.
	if len(message) > max {
		end := max
		for end > 0 && !utf8.RuneStart(message[end]) {
			end--
		}
		message, cut = message[:end], true
	}
	encoded := appendJSONString(nil, message)
	if !cut && len(encoded) <= max {
		return encoded
	}
	marker := appendJSONString(nil, truncationMarker)
	prefix := truncateJSONString(encoded, max-(len(marker)-2))
	if prefix == nil {
		return marker
	}
	out := make([]byte, 0, len(prefix)+len(marker))
	out = append(out, prefix[:len(prefix)-1]...)
	return append(out, marker[1:]...)
}
