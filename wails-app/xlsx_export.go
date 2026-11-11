package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/xuri/excelize/v2"
)

const (
	xlsxMaxRows       = 1_048_576
	xlsxMaxColumns    = 16_384
	xlsxStreamAtRows  = 10_000
	xlsxMaxColumnSize = 60
)

// SaveXLSXAs writes a result set through the native Save dialog.
func (a *App) SaveXLSXAs(filename string, columns []ColumnInfo, rows [][]any) (string, error) {
	if a.app == nil || a.app.Dialog == nil {
		return "", errors.New("dialogs unavailable")
	}
	if err := validateXLSXDimensions(len(columns), len(rows)); err != nil {
		return "", err
	}
	if len(columns) == 0 {
		return "", errors.New("result has no columns to export")
	}
	filename = ensureXLSXExtension(filename)
	opts := &application.SaveFileDialogOptions{
		CanCreateDirectories: true,
		Title:                "Save Excel Workbook",
		Filename:             filename,
		Directory:            spoolDownloadDir(),
		Filters:              []application.FileFilter{{DisplayName: "Excel Workbook", Pattern: "*.xlsx"}},
	}
	path, err := a.app.Dialog.SaveFileWithOptions(opts).PromptForSingleSelection()
	if err != nil || strings.TrimSpace(path) == "" {
		return "", err
	}
	path = ensureXLSXExtension(path)
	data, err := buildXLSXWithSettings(columns, rows, loadAppSettings())
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func ensureXLSXExtension(path string) string {
	ext := filepath.Ext(path)
	if strings.EqualFold(ext, ".xlsx") {
		return path
	}
	return strings.TrimSuffix(path, ext) + ".xlsx"
}

func validateXLSXDimensions(columnCount, rowCount int) error {
	if columnCount > xlsxMaxColumns {
		return fmt.Errorf("Excel supports at most %d columns per worksheet; result has %d", xlsxMaxColumns, columnCount)
	}
	if rowCount+1 > xlsxMaxRows {
		return fmt.Errorf("Excel supports at most %d rows including the heading; result has %d data rows", xlsxMaxRows, rowCount)
	}
	return nil
}

func buildXLSX(columns []ColumnInfo, rows [][]any) ([]byte, error) {
	return buildXLSXWithSettings(columns, rows, AppSettings{})
}

func buildXLSXWithSettings(columns []ColumnInfo, rows [][]any, settings AppSettings) ([]byte, error) {
	if err := validateXLSXDimensions(len(columns), len(rows)); err != nil {
		return nil, err
	}
	if len(columns) == 0 {
		return nil, errors.New("result has no columns to export")
	}
	for rowIndex, row := range rows {
		if len(row) != len(columns) {
			return nil, fmt.Errorf("row %d has %d values for %d columns", rowIndex+1, len(row), len(columns))
		}
	}

	workbook := excelize.NewFile()
	defer workbook.Close()
	const sheet = "SQL Results"
	workbook.SetSheetName(workbook.GetSheetName(0), sheet)
	if err := workbook.SetPanes(sheet, &excelize.Panes{
		Freeze:      true,
		YSplit:      1,
		TopLeftCell: "A2",
		ActivePane:  "bottomLeft",
	}); err != nil {
		return nil, err
	}

	headerStyle, err := workbook.NewStyle(&excelize.Style{
		Font: &excelize.Font{Bold: true},
		Fill: excelize.Fill{Type: "pattern", Color: []string{"E8EEF5"}, Pattern: 1},
	})
	if err != nil {
		return nil, err
	}
	styles := map[int]int{}
	styleForScale := func(scale int) (int, error) {
		if style, ok := styles[scale]; ok {
			return style, nil
		}
		format := "0"
		if scale > 0 {
			format += "." + strings.Repeat("0", scale)
		}
		style, styleErr := workbook.NewStyle(&excelize.Style{CustomNumFmt: &format})
		if styleErr == nil {
			styles[scale] = style
		}
		return style, styleErr
	}
	dateStyle, err := workbook.NewStyle(xlsxDateCellStyle(settings.ExcelDateFormat))
	if err != nil {
		return nil, err
	}
	timeStyle, err := workbook.NewStyle(xlsxTimeCellStyle(settings.ExcelTimeFormat))
	if err != nil {
		return nil, err
	}
	timestampStyle, err := workbook.NewStyle(xlsxTimestampCellStyle(settings.ExcelTimestampFormat))
	if err != nil {
		return nil, err
	}

	widths := xlsxColumnWidths(columns, rows, settings.ExcelColumnHeading)
	for colIndex, width := range widths {
		columnName, _ := excelize.ColumnNumberToName(colIndex + 1)
		if err := workbook.SetColWidth(sheet, columnName, columnName, width); err != nil {
			return nil, err
		}
	}

	if len(rows) >= xlsxStreamAtRows {
		stream, err := workbook.NewStreamWriter(sheet)
		if err != nil {
			return nil, err
		}
		header := make([]interface{}, len(columns))
		for i, column := range columns {
			header[i] = excelize.Cell{Value: xlsxColumnName(column, settings.ExcelColumnHeading), StyleID: headerStyle}
		}
		if err := stream.SetRow("A1", header); err != nil {
			return nil, err
		}
		for rowIndex, row := range rows {
			cells := make([]interface{}, len(columns))
			for colIndex, value := range row {
				cell, cellErr := xlsxCell(value, columns[colIndex], dateStyle, timeStyle, timestampStyle, styleForScale)
				if cellErr != nil {
					return nil, fmt.Errorf("row %d column %q: %w", rowIndex+1, columns[colIndex].Name, cellErr)
				}
				cells[colIndex] = cell
			}
			cellName, _ := excelize.CoordinatesToCellName(1, rowIndex+2)
			if err := stream.SetRow(cellName, cells); err != nil {
				return nil, err
			}
		}
		if err := stream.Flush(); err != nil {
			return nil, err
		}
	} else {
		for colIndex, column := range columns {
			cellName, _ := excelize.CoordinatesToCellName(colIndex+1, 1)
			if err := workbook.SetCellValue(sheet, cellName, xlsxColumnName(column, settings.ExcelColumnHeading)); err != nil {
				return nil, err
			}
			if err := workbook.SetCellStyle(sheet, cellName, cellName, headerStyle); err != nil {
				return nil, err
			}
		}
		for rowIndex, row := range rows {
			for colIndex, value := range row {
				cell, cellErr := xlsxCell(value, columns[colIndex], dateStyle, timeStyle, timestampStyle, styleForScale)
				if cellErr != nil {
					return nil, fmt.Errorf("row %d column %q: %w", rowIndex+1, columns[colIndex].Name, cellErr)
				}
				cellName, _ := excelize.CoordinatesToCellName(colIndex+1, rowIndex+2)
				if err := workbook.SetCellValue(sheet, cellName, cell.Value); err != nil {
					return nil, err
				}
				if cell.StyleID != 0 {
					if err := workbook.SetCellStyle(sheet, cellName, cellName, cell.StyleID); err != nil {
						return nil, err
					}
				}
			}
		}
	}
	var output bytes.Buffer
	if err := workbook.Write(&output); err != nil {
		return nil, err
	}
	lastCell, err := excelize.CoordinatesToCellName(len(columns), len(rows)+1)
	if err != nil {
		return nil, err
	}
	return correctXLSXMetadata(output.Bytes(), "A1:"+lastCell)
}

func xlsxDateCellStyle(format string) *excelize.Style {
	switch format {
	case "iso":
		return &excelize.Style{CustomNumFmt: stringPointer("yyyy-mm-dd")}
	case "us":
		return &excelize.Style{CustomNumFmt: stringPointer("mm/dd/yyyy")}
	case "eu":
		return &excelize.Style{CustomNumFmt: stringPointer("dd/mm/yyyy")}
	case "mdy":
		return &excelize.Style{CustomNumFmt: stringPointer("mm/dd/yy")}
	case "mdyy":
		return &excelize.Style{CustomNumFmt: stringPointer("mm/dd/yyyy")}
	case "dmy":
		return &excelize.Style{CustomNumFmt: stringPointer("dd/mm/yy")}
	case "dmyy":
		return &excelize.Style{CustomNumFmt: stringPointer("dd/mm/yyyy")}
	case "ymd":
		return &excelize.Style{CustomNumFmt: stringPointer("yy/mm/dd")}
	case "yymd":
		return &excelize.Style{CustomNumFmt: stringPointer("yyyy/mm/dd")}
	default:
		return &excelize.Style{NumFmt: 14}
	}
}

func xlsxTimeCellStyle(format string) *excelize.Style {
	switch format {
	case "24h":
		return &excelize.Style{CustomNumFmt: stringPointer("hh:mm:ss")}
	case "12h":
		return &excelize.Style{CustomNumFmt: stringPointer("h:mm:ss AM/PM")}
	case "iso":
		return &excelize.Style{CustomNumFmt: stringPointer(`hh"."mm"."ss`)}
	case "iso12":
		return &excelize.Style{CustomNumFmt: stringPointer(`hh"."mm"."ss AM/PM`)}
	default:
		return &excelize.Style{NumFmt: 21}
	}
}

func xlsxTimestampCellStyle(format string) *excelize.Style {
	switch format {
	case "", "locale":
		return &excelize.Style{CustomNumFmt: stringPointer(localeTimestampNumberFormat(systemLocaleTag()))}
	case "iso":
		return &excelize.Style{CustomNumFmt: stringPointer(`yyyy-mm-dd"T"hh:mm:ss.000`)}
	case "us":
		return &excelize.Style{CustomNumFmt: stringPointer("mm/dd/yyyy h:mm:ss.000 AM/PM")}
	case "eu":
		return &excelize.Style{CustomNumFmt: stringPointer("dd/mm/yyyy hh:mm:ss.000")}
	case "ibmi":
		return &excelize.Style{CustomNumFmt: stringPointer("yyyy-mm-dd hh:mm:ss")}
	case "ibmiDot":
		return &excelize.Style{CustomNumFmt: stringPointer(`yyyy-mm-dd hh"."mm"."ss`)}
	default:
		return &excelize.Style{CustomNumFmt: stringPointer(localeTimestampNumberFormat(systemLocaleTag()))}
	}
}

func systemLocaleTag() string {
	if runtime.GOOS == "darwin" {
		if output, err := exec.Command("defaults", "read", "-g", "AppleLocale").Output(); err == nil {
			if locale := normalizeLocaleTag(string(output)); locale != "" {
				return locale
			}
		}
	}
	for _, key := range []string{"LC_ALL", "LC_TIME", "LANG"} {
		if locale := normalizeLocaleTag(os.Getenv(key)); locale != "" && locale != "C" && locale != "POSIX" {
			return locale
		}
	}
	return ""
}

func normalizeLocaleTag(locale string) string {
	locale = strings.TrimSpace(locale)
	if dot := strings.IndexByte(locale, '.'); dot >= 0 {
		locale = locale[:dot]
	}
	if at := strings.IndexByte(locale, '@'); at >= 0 {
		locale = locale[:at]
	}
	return strings.ReplaceAll(locale, "-", "_")
}

func localeTimestampNumberFormat(locale string) string {
	region := ""
	if _, region, _ = strings.Cut(locale, "_"); region == "" {
		return "yyyy-mm-dd hh:mm:ss"
	}
	region = strings.ToUpper(region)
	switch region {
	case "US", "PH", "FM", "PW":
		return "m/d/yy h:mm:ss AM/PM"
	case "JP", "CN", "KR", "TW":
		return "yyyy/m/d hh:mm:ss"
	default:
		return "dd/mm/yyyy hh:mm:ss"
	}
}

func correctXLSXMetadata(data []byte, dimension string) ([]byte, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("read XLSX package: %w", err)
	}
	stringRefs := 0
	worksheetParts := make(map[string][]byte)
	for _, file := range archive.File {
		if !strings.HasPrefix(file.Name, "xl/worksheets/") || !strings.HasSuffix(file.Name, ".xml") {
			continue
		}
		contents, err := readXLSXZipPart(file)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", file.Name, err)
		}
		count, err := countSharedStringRefs(contents)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", file.Name, err)
		}
		stringRefs += count
		contents, err = setXMLAttribute(contents, "dimension", "ref", dimension)
		if err != nil {
			return nil, fmt.Errorf("update %s dimension: %w", file.Name, err)
		}
		worksheetParts[file.Name] = contents
	}

	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, file := range archive.File {
		contents, err := readXLSXZipPart(file)
		if err != nil {
			_ = writer.Close()
			return nil, fmt.Errorf("read %s: %w", file.Name, err)
		}
		if worksheet, ok := worksheetParts[file.Name]; ok {
			contents = worksheet
		}
		if file.Name == "xl/sharedStrings.xml" {
			contents, err = setSharedStringCount(contents, stringRefs)
			if err != nil {
				_ = writer.Close()
				return nil, fmt.Errorf("update shared string count: %w", err)
			}
		}
		header := file.FileHeader
		partWriter, err := writer.CreateHeader(&header)
		if err != nil {
			_ = writer.Close()
			return nil, err
		}
		if _, err := partWriter.Write(contents); err != nil {
			_ = writer.Close()
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func readXLSXZipPart(file *zip.File) ([]byte, error) {
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}

func countSharedStringRefs(data []byte) (int, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	count := 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return count, nil
		}
		if err != nil {
			return 0, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "c" {
			continue
		}
		for _, attr := range start.Attr {
			if attr.Name.Local == "t" && attr.Value == "s" {
				count++
				break
			}
		}
	}
}

func setSharedStringCount(data []byte, count int) ([]byte, error) {
	return setXMLAttribute(data, "sst", "count", fmt.Sprint(count))
}

func setXMLAttribute(data []byte, elementName, attributeName, value string) ([]byte, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	pattern := regexp.MustCompile(`(\s` + regexp.QuoteMeta(attributeName) + `=")[^"]*(")`)
	for {
		startOffset := decoder.InputOffset()
		token, err := decoder.Token()
		if err == io.EOF {
			return nil, fmt.Errorf("XML element %q is missing", elementName)
		}
		if err != nil {
			return nil, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != elementName {
			continue
		}
		endOffset := decoder.InputOffset()
		tag := data[startOffset:endOffset]
		match := pattern.FindSubmatchIndex(tag)
		if match == nil {
			return nil, fmt.Errorf("attribute %q is missing from %q", attributeName, elementName)
		}
		updated := make([]byte, 0, len(data)+len(value))
		updated = append(updated, data[:startOffset]...)
		updated = append(updated, tag[:match[3]]...)
		updated = append(updated, value...)
		updated = append(updated, tag[match[4]:]...)
		updated = append(updated, data[endOffset:]...)
		return updated, nil
	}
}

func xlsxCell(value any, column ColumnInfo, dateStyle, timeStyle, timestampStyle int, styleForScale func(int) (int, error)) (excelize.Cell, error) {
	if value == nil {
		return excelize.Cell{}, nil
	}
	switch xlsxColumnKind(column) {
	case "date":
		if parsed, ok := parseXLSXDate(value); ok {
			return excelize.Cell{Value: parsed, StyleID: dateStyle}, nil
		}
	case "time":
		if parsed, ok := parseXLSXTime(value); ok {
			seconds := float64(parsed.Hour()*3600 + parsed.Minute()*60 + parsed.Second())
			fraction := (seconds + float64(parsed.Nanosecond())/1e9) / 86_400
			return excelize.Cell{Value: fraction, StyleID: timeStyle}, nil
		}
	case "timestamp":
		if parsed, ok := parseXLSXTimestamp(value); ok {
			return excelize.Cell{Value: parsed, StyleID: timestampStyle}, nil
		}
	case "number":
		if numeric, ok := xlsxNumericValue(value, column); ok {
			if isExactXLSXNumeric(column) && column.Scale >= 0 {
				style, err := styleForScale(column.Scale)
				if err != nil {
					return excelize.Cell{}, err
				}
				return excelize.Cell{Value: numeric, StyleID: style}, nil
			}
			return excelize.Cell{Value: numeric}, nil
		}
	}
	return excelize.Cell{Value: fmt.Sprint(value)}, nil
}

func xlsxColumnName(column ColumnInfo, choice string) string {
	name := strings.TrimSpace(column.Name)
	label := strings.Join(strings.Fields(column.Label), " ")
	if choice != "fieldName" && label != "" {
		return label
	}
	if name != "" {
		return name
	}
	return label
}

func xlsxColumnWidths(columns []ColumnInfo, rows [][]any, choice string) []float64 {
	widths := make([]float64, len(columns))
	for index, column := range columns {
		width := float64(len([]rune(xlsxColumnName(column, choice))) + 2)
		if width < 10 {
			width = 10
		}
		widths[index] = width
	}
	for _, row := range rows {
		for index, value := range row {
			if value == nil {
				continue
			}
			width := float64(len([]rune(fmt.Sprint(value))) + 2)
			if width > widths[index] {
				widths[index] = width
			}
		}
	}
	for index, width := range widths {
		if width > xlsxMaxColumnSize {
			widths[index] = xlsxMaxColumnSize
		}
	}
	return widths
}

func xlsxColumnKind(column ColumnInfo) string {
	base := strings.ToUpper(strings.TrimSpace(column.TypeName))
	if before, _, found := strings.Cut(base, "("); found {
		base = strings.TrimSpace(before)
	}
	switch {
	case base == "DATE" || column.Type == 91:
		return "date"
	case base == "TIME" || column.Type == 92:
		return "time"
	case strings.HasPrefix(base, "TIMESTAMP") || base == "TIMESTMP" || column.Type == 93 || column.Type == 2014:
		return "timestamp"
	case isXLSXNumeric(column):
		return "number"
	default:
		return "text"
	}
}

func isXLSXNumeric(column ColumnInfo) bool {
	base := strings.ToUpper(strings.TrimSpace(column.TypeName))
	if before, _, found := strings.Cut(base, "("); found {
		base = strings.TrimSpace(before)
	}
	switch base {
	case "SMALLINT", "INTEGER", "INT", "BIGINT", "TINYINT", "DEC", "DECIMAL", "NUM", "NUMERIC", "DECFLOAT", "REAL", "DOUBLE", "DOUBLE PRECISION", "FLOAT":
		return true
	}
	switch column.Type {
	case -6, -5, 5, 4, 2, 3, 6, 7, 8:
		return true
	default:
		return false
	}
}

func isExactXLSXNumeric(column ColumnInfo) bool {
	base := strings.ToUpper(strings.TrimSpace(column.TypeName))
	if before, _, found := strings.Cut(base, "("); found {
		base = strings.TrimSpace(before)
	}
	return base == "DEC" || base == "DECIMAL" || base == "NUM" || base == "NUMERIC" || column.Type == 2 || column.Type == 3
}

func xlsxNumericValue(value any, column ColumnInfo) (float64, bool) {
	if number, ok := value.(float64); ok {
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return 0, false
		}
		if math.Trunc(number) == number && math.Abs(number) > 999_999_999_999_999 {
			return 0, false
		}
		return number, true
	}
	if number, ok := value.(float32); ok {
		return float64(number), true
	}
	if text, ok := value.(string); ok {
		text = strings.TrimSpace(text)
		if !isPlainDecimal(text) || significantDecimalDigits(text) > 15 || column.Scale > 30 {
			return 0, false
		}
		number, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsInf(number, 0) || math.IsNaN(number) {
			return 0, false
		}
		if column.Scale >= 0 {
			rounded := strconv.FormatFloat(number, 'f', column.Scale, 64)
			if !decimalEqualAtScale(text, rounded) {
				return 0, false
			}
		}
		return number, true
	}
	switch number := value.(type) {
	case int:
		return float64(number), true
	case int8:
		return float64(number), true
	case int16:
		return float64(number), true
	case int32:
		return float64(number), true
	case int64:
		if number > 999_999_999_999_999 || number < -999_999_999_999_999 {
			return 0, false
		}
		return float64(number), true
	case uint:
		if uint64(number) > 999_999_999_999_999 {
			return 0, false
		}
		return float64(number), true
	case uint8:
		return float64(number), true
	case uint16:
		return float64(number), true
	case uint32:
		return float64(number), true
	case uint64:
		if number > 999_999_999_999_999 {
			return 0, false
		}
		return float64(number), true
	default:
		return 0, false
	}
}

func isPlainDecimal(value string) bool {
	if value == "" {
		return false
	}
	if value[0] == '+' || value[0] == '-' {
		value = value[1:]
	}
	if value == "" {
		return false
	}
	dot := false
	digits := 0
	for _, char := range value {
		switch {
		case char >= '0' && char <= '9':
			digits++
		case char == '.' && !dot:
			dot = true
		default:
			return false
		}
	}
	return digits > 0
}

func significantDecimalDigits(value string) int {
	value = strings.TrimLeft(value, "+-")
	value = strings.ReplaceAll(value, ".", "")
	value = strings.TrimLeft(value, "0")
	value = strings.TrimRight(value, "0")
	if value == "" {
		return 1
	}
	return len(value)
}

func decimalEqualAtScale(left, right string) bool {
	normalize := func(value string) (string, string, string) {
		value = strings.TrimSpace(value)
		sign := ""
		if strings.HasPrefix(value, "-") {
			sign = "-"
			value = value[1:]
		} else if strings.HasPrefix(value, "+") {
			value = value[1:]
		}
		integer, fraction, _ := strings.Cut(value, ".")
		integer = strings.TrimLeft(integer, "0")
		if integer == "" {
			integer = "0"
		}
		fraction = strings.TrimRight(fraction, "0")
		if integer == "0" && fraction == "" {
			sign = ""
		}
		return sign, integer, fraction
	}
	leftSign, leftInteger, leftFraction := normalize(left)
	rightSign, rightInteger, rightFraction := normalize(right)
	return leftSign == rightSign && leftInteger == rightInteger && leftFraction == rightFraction
}

func parseXLSXDate(value any) (time.Time, bool) {
	parsed, err := time.Parse("2006-01-02", fmt.Sprint(value))
	return parsed, err == nil
}

func parseXLSXTime(value any) (time.Time, bool) {
	text := fmt.Sprint(value)
	for _, layout := range []string{"15:04:05.999999999", "15:04:05", "15:04"} {
		parsed, err := time.Parse(layout, text)
		if err == nil {
			return time.Date(1899, 12, 30, parsed.Hour(), parsed.Minute(), parsed.Second(), parsed.Nanosecond(), time.UTC), true
		}
	}
	return time.Time{}, false
}

func parseXLSXTimestamp(value any) (time.Time, bool) {
	text := fmt.Sprint(value)
	for _, layout := range []string{"2006-01-02 15:04:05.999999999", "2006-01-02 15:04:05", "2006-01-02T15:04:05.999999999", "2006-01-02T15:04:05"} {
		parsed, err := time.ParseInLocation(layout, text, time.UTC)
		if err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func stringPointer(value string) *string { return &value }
