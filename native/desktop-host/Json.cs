// Minimal strict JSON reader/writer for the line protocol. Deliberately small:
// the host only accepts a flat command object, so a full serializer would add
// attack surface without adding value. Parsing is strict (no trailing bytes, no
// duplicate-key ambiguity, bounded depth, bounded numbers) and writing escapes
// every control character so a UIA label can never corrupt a protocol line.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace DesktopHost
{
    internal enum JsonKind
    {
        Object,
        Array,
        String,
        Number,
        Boolean,
        Null,
    }

    internal sealed class JsonParseException : Exception
    {
        internal JsonParseException(string message)
            : base(message)
        {
        }
    }

    internal sealed class JsonValue
    {
        internal JsonKind Kind;
        internal Dictionary<string, JsonValue> Members;
        internal List<JsonValue> Items;
        internal string Text;
        internal double Number;
        internal bool Boolean;

        internal bool TryGetMember(string name, out JsonValue value)
        {
            value = null;
            return Kind == JsonKind.Object && Members != null && Members.TryGetValue(name, out value);
        }
    }

    internal sealed class JsonParser
    {
        private const int MaxDepth = 16;
        private const int MaxInputChars = 2 * 1024 * 1024;

        private readonly string _text;
        private int _offset;

        private JsonParser(string text)
        {
            _text = text;
        }

        internal static JsonValue Parse(string text)
        {
            if (text == null) throw new JsonParseException("JSON input is missing.");
            if (text.Length > MaxInputChars) throw new JsonParseException("JSON input is too large.");
            JsonParser parser = new JsonParser(text);
            JsonValue value = parser.ParseValue(0);
            parser.SkipWhitespace();
            if (parser._offset != text.Length) throw new JsonParseException("Trailing data after JSON value.");
            return value;
        }

        private void SkipWhitespace()
        {
            while (_offset < _text.Length)
            {
                char c = _text[_offset];
                if (c == ' ' || c == '\t' || c == '\r' || c == '\n')
                {
                    _offset++;
                    continue;
                }
                break;
            }
        }

        private JsonValue ParseValue(int depth)
        {
            if (depth > MaxDepth) throw new JsonParseException("JSON nesting is too deep.");
            SkipWhitespace();
            if (_offset >= _text.Length) throw new JsonParseException("Unexpected end of JSON input.");
            char c = _text[_offset];
            if (c == '{') return ParseObject(depth + 1);
            if (c == '[') return ParseArray(depth + 1);
            if (c == '"')
            {
                JsonValue value = new JsonValue();
                value.Kind = JsonKind.String;
                value.Text = ParseString();
                return value;
            }
            if (c == 't') return ParseLiteral("true", JsonKind.Boolean, true);
            if (c == 'f') return ParseLiteral("false", JsonKind.Boolean, false);
            if (c == 'n') return ParseNullLiteral();
            if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber();
            throw new JsonParseException("Unexpected JSON token.");
        }

        private JsonValue ParseLiteral(string literal, JsonKind kind, bool boolean)
        {
            if (_offset + literal.Length > _text.Length ||
                string.CompareOrdinal(_text, _offset, literal, 0, literal.Length) != 0)
            {
                throw new JsonParseException("Malformed JSON literal.");
            }
            _offset += literal.Length;
            JsonValue value = new JsonValue();
            value.Kind = kind;
            value.Boolean = boolean;
            return value;
        }

        private JsonValue ParseNullLiteral()
        {
            JsonValue value = ParseLiteral("null", JsonKind.Null, false);
            return value;
        }

        private JsonValue ParseNumber()
        {
            int start = _offset;
            if (_text[_offset] == '-') _offset++;
            bool digits = false;
            while (_offset < _text.Length && _text[_offset] >= '0' && _text[_offset] <= '9')
            {
                _offset++;
                digits = true;
            }
            if (!digits) throw new JsonParseException("Malformed JSON number.");
            if (_offset < _text.Length && _text[_offset] == '.')
            {
                _offset++;
                bool fractionDigits = false;
                while (_offset < _text.Length && _text[_offset] >= '0' && _text[_offset] <= '9')
                {
                    _offset++;
                    fractionDigits = true;
                }
                if (!fractionDigits) throw new JsonParseException("Malformed JSON number.");
            }
            if (_offset < _text.Length && (_text[_offset] == 'e' || _text[_offset] == 'E'))
            {
                _offset++;
                if (_offset < _text.Length && (_text[_offset] == '+' || _text[_offset] == '-')) _offset++;
                bool exponentDigits = false;
                while (_offset < _text.Length && _text[_offset] >= '0' && _text[_offset] <= '9')
                {
                    _offset++;
                    exponentDigits = true;
                }
                if (!exponentDigits) throw new JsonParseException("Malformed JSON number.");
            }
            string raw = _text.Substring(start, _offset - start);
            if (raw.Length > 64) throw new JsonParseException("JSON number is too long.");
            double parsed;
            if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) ||
                double.IsNaN(parsed) || double.IsInfinity(parsed))
            {
                throw new JsonParseException("Malformed JSON number.");
            }
            JsonValue value = new JsonValue();
            value.Kind = JsonKind.Number;
            value.Number = parsed;
            return value;
        }

        private string ParseString()
        {
            if (_text[_offset] != '"') throw new JsonParseException("Expected a JSON string.");
            _offset++;
            StringBuilder builder = new StringBuilder();
            while (true)
            {
                if (_offset >= _text.Length) throw new JsonParseException("Unterminated JSON string.");
                char c = _text[_offset++];
                if (c == '"') return builder.ToString();
                if (c == '\\')
                {
                    if (_offset >= _text.Length) throw new JsonParseException("Unterminated JSON escape.");
                    char escape = _text[_offset++];
                    switch (escape)
                    {
                        case '"': builder.Append('"'); break;
                        case '\\': builder.Append('\\'); break;
                        case '/': builder.Append('/'); break;
                        case 'b': builder.Append('\b'); break;
                        case 'f': builder.Append('\f'); break;
                        case 'n': builder.Append('\n'); break;
                        case 'r': builder.Append('\r'); break;
                        case 't': builder.Append('\t'); break;
                        case 'u':
                            if (_offset + 4 > _text.Length) throw new JsonParseException("Truncated JSON escape.");
                            string hex = _text.Substring(_offset, 4);
                            int code;
                            if (!int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                            {
                                throw new JsonParseException("Malformed JSON escape.");
                            }
                            builder.Append((char)code);
                            _offset += 4;
                            break;
                        default:
                            throw new JsonParseException("Unsupported JSON escape.");
                    }
                    continue;
                }
                if (c < 0x20) throw new JsonParseException("Control character inside JSON string.");
                builder.Append(c);
                if (builder.Length > 1024 * 1024) throw new JsonParseException("JSON string is too large.");
            }
        }

        private JsonValue ParseObject(int depth)
        {
            _offset++;
            JsonValue value = new JsonValue();
            value.Kind = JsonKind.Object;
            value.Members = new Dictionary<string, JsonValue>(StringComparer.Ordinal);
            SkipWhitespace();
            if (_offset < _text.Length && _text[_offset] == '}')
            {
                _offset++;
                return value;
            }
            while (true)
            {
                SkipWhitespace();
                if (_offset >= _text.Length || _text[_offset] != '"') throw new JsonParseException("Expected a JSON object key.");
                string key = ParseString();
                if (value.Members.ContainsKey(key)) throw new JsonParseException("Duplicate JSON object key.");
                SkipWhitespace();
                if (_offset >= _text.Length || _text[_offset] != ':') throw new JsonParseException("Expected ':' after JSON object key.");
                _offset++;
                value.Members[key] = ParseValue(depth + 1);
                SkipWhitespace();
                if (_offset >= _text.Length) throw new JsonParseException("Unterminated JSON object.");
                char next = _text[_offset++];
                if (next == ',') continue;
                if (next == '}') return value;
                throw new JsonParseException("Expected ',' or '}' in JSON object.");
            }
        }

        private JsonValue ParseArray(int depth)
        {
            _offset++;
            JsonValue value = new JsonValue();
            value.Kind = JsonKind.Array;
            value.Items = new List<JsonValue>();
            SkipWhitespace();
            if (_offset < _text.Length && _text[_offset] == ']')
            {
                _offset++;
                return value;
            }
            while (true)
            {
                value.Items.Add(ParseValue(depth + 1));
                if (value.Items.Count > 100000) throw new JsonParseException("JSON array is too large.");
                SkipWhitespace();
                if (_offset >= _text.Length) throw new JsonParseException("Unterminated JSON array.");
                char next = _text[_offset++];
                if (next == ',') continue;
                if (next == ']') return value;
                throw new JsonParseException("Expected ',' or ']' in JSON array.");
            }
        }
    }

    /// <summary>
    /// Append-only protocol writer. Callers must keep the sequence well formed;
    /// a malformed sequence would only ever produce a rejected line, never an
    /// injection into the protocol.
    /// </summary>
    internal sealed class JsonBuilder
    {
        private readonly StringBuilder _builder = new StringBuilder(256);
        /// <summary>True when the matching container already holds a value.</summary>
        private readonly Stack<bool> _containerDirty = new Stack<bool>();
        private bool _pendingName;

        public override string ToString()
        {
            return _builder.ToString();
        }

        internal void StartObject()
        {
            WriteValueSeparator();
            _builder.Append('{');
            _containerDirty.Push(false);
        }

        internal void EndObject()
        {
            _builder.Append('}');
            if (_containerDirty.Count > 0) _containerDirty.Pop();
        }

        internal void StartArray()
        {
            WriteValueSeparator();
            _builder.Append('[');
            _containerDirty.Push(false);
        }

        internal void EndArray()
        {
            _builder.Append(']');
            if (_containerDirty.Count > 0) _containerDirty.Pop();
        }

        internal JsonBuilder Name(string name)
        {
            WriteMemberSeparator();
            AppendQuoted(name);
            _builder.Append(':');
            _pendingName = true;
            return this;
        }

        internal JsonBuilder Value(string text)
        {
            WriteValueSeparator();
            if (text == null) _builder.Append("null");
            else AppendQuoted(text);
            return this;
        }

        internal JsonBuilder Value(long number)
        {
            WriteValueSeparator();
            _builder.Append(number.ToString(CultureInfo.InvariantCulture));
            return this;
        }

        internal JsonBuilder Value(double number)
        {
            WriteValueSeparator();
            if (double.IsNaN(number) || double.IsInfinity(number))
            {
                _builder.Append("null");
                return this;
            }
            _builder.Append(number.ToString("R", CultureInfo.InvariantCulture));
            return this;
        }

        internal JsonBuilder Value(bool flag)
        {
            WriteValueSeparator();
            _builder.Append(flag ? "true" : "false");
            return this;
        }

        internal JsonBuilder Null()
        {
            WriteValueSeparator();
            _builder.Append("null");
            return this;
        }

        private void WriteValueSeparator()
        {
            // A value completes a pending object member, so no comma belongs
            // before it; any other value in the same container needs one.
            if (_pendingName)
            {
                _pendingName = false;
                MarkContainerDirty();
                return;
            }
            WriteMemberSeparator();
        }

        private void WriteMemberSeparator()
        {
            if (_containerDirty.Count > 0 && _containerDirty.Peek()) _builder.Append(',');
            if (_containerDirty.Count > 0)
            {
                _containerDirty.Pop();
                _containerDirty.Push(true);
            }
        }

        private void MarkContainerDirty()
        {
            if (_containerDirty.Count > 0)
            {
                _containerDirty.Pop();
                _containerDirty.Push(true);
            }
        }

        private void AppendQuoted(string text)
        {
            _builder.Append('"');
            foreach (char c in text)
            {
                switch (c)
                {
                    case '"': _builder.Append("\\\""); break;
                    case '\\': _builder.Append("\\\\"); break;
                    case '\b': _builder.Append("\\b"); break;
                    case '\f': _builder.Append("\\f"); break;
                    case '\n': _builder.Append("\\n"); break;
                    case '\r': _builder.Append("\\r"); break;
                    case '\t': _builder.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == 0x7f)
                        {
                            _builder.Append("\\u");
                            _builder.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            _builder.Append(c);
                        }
                        break;
                }
            }
            _builder.Append('"');
        }
    }
}
