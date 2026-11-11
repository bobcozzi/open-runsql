package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

var testXLSXSettings = AppSettings{
	ExcelDateFormat:      "iso",
	ExcelTimeFormat:      "24h",
	ExcelTimestampFormat: "iso",
}

func TestExcelColumnHeadingSetting(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("HOME", configDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)
	t.Setenv("AppData", configDir)
	app := &App{}
	for _, value := range []string{"fieldName", "columnHeading", ""} {
		if err := app.SetAppSetting("excelColumnHeading", value); err != nil {
			t.Fatalf("save %q: %v", value, err)
		}
		if got := loadAppSettings().ExcelColumnHeading; got != value {
			t.Errorf("saved heading setting = %q; want %q", got, value)
		}
	}
	if err := app.SetAppSetting("excelColumnHeading", "invalid"); err == nil {
		t.Fatal("invalid heading setting was accepted")
	}
}

func TestBuildXLSXColumnHeadings(t *testing.T) {
	columns := []ColumnInfo{
		{Name: "CUSTNO", Label: "Customer   Number"},
		{Name: "NO_LABEL", Label: "   "},
		{Label: "Label Only"},
	}
	for _, choice := range []string{"", "columnHeading", "fieldName"} {
		for _, rowCount := range []int{0, xlsxStreamAtRows} {
			t.Run(fmt.Sprintf("%s/rows-%d", choice, rowCount), func(t *testing.T) {
				rows := make([][]any, rowCount)
				for index := range rows {
					rows[index] = []any{nil, nil, nil}
				}
				data, err := buildXLSXWithSettings(columns, rows, AppSettings{ExcelColumnHeading: choice})
				if err != nil {
					t.Fatal(err)
				}
				workbook, err := excelize.OpenReader(bytes.NewReader(data))
				if err != nil {
					t.Fatal(err)
				}
				defer workbook.Close()
				first := "Customer Number"
				if choice == "fieldName" {
					first = "CUSTNO"
				}
				for cell, want := range map[string]string{"A1": first, "B1": "NO_LABEL", "C1": "Label Only"} {
					got, err := workbook.GetCellValue("SQL Results", cell)
					if err != nil || got != want {
						t.Errorf("%s = %q, err=%v; want %q", cell, got, err, want)
					}
				}
				width, err := workbook.GetColWidth("SQL Results", "A")
				if err != nil || width < float64(len(first)+2) {
					t.Errorf("column A width = %v, err=%v; want room for %q", width, err, first)
				}
			})
		}
	}
}

func TestBuildXLSXPreservesTypesAndMetadata(t *testing.T) {
	columns := []ColumnInfo{
		{Name: "Customer ID", Type: 12, TypeName: "VARCHAR"},
		{Name: "Large Integer", Type: -5, TypeName: "BIGINT", Precision: 19},
		{Name: "Amount", Type: 3, TypeName: "DECIMAL", Precision: 10, Scale: 2},
		{Name: "Exact Amount", Type: 3, TypeName: "DECIMAL", Precision: 20, Scale: 4},
		{Name: "Start Date", Type: 91, TypeName: "DATE"},
		{Name: "Start Time", Type: 92, TypeName: "TIME"},
		{Name: "Created At", Type: 93, TypeName: "TIMESTAMP"},
		{Name: "Date-like Text / CHAR", Type: 12, TypeName: "VARCHAR"},
		{Name: "Nullable", Type: 12, TypeName: "VARCHAR"},
	}
	rows := [][]any{{
		"00123", "9007199254740993", "1234.50", "1234567890123456.7890",
		"2026-11-10", "13:14:15.123456", "2026-11-10 13:14:15.123456", "2026-11-10", nil,
	}}
	data, err := buildXLSXWithSettings(columns, rows, testXLSXSettings)
	if err != nil {
		t.Fatal(err)
	}
	assertValidXLSXPackage(t, data)
	workbook, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer workbook.Close()
	if got := workbook.GetSheetName(0); got != "SQL Results" {
		t.Fatalf("sheet name = %q", got)
	}
	if got, err := workbook.GetSheetDimension("SQL Results"); err != nil || got != "A1:I2" {
		t.Errorf("worksheet dimension = %q, err=%v; want A1:I2", got, err)
	}
	panes, err := workbook.GetPanes("SQL Results")
	if err != nil || !panes.Freeze || panes.YSplit != 1 || panes.TopLeftCell != "A2" {
		t.Errorf("frozen header panes = %+v, err=%v", panes, err)
	}
	for cell, want := range map[string]string{
		"A1": "Customer ID", "A2": "00123", "B2": "9007199254740993",
		"C2": "1234.50", "D2": "1234567890123456.7890", "E2": "2026-11-10",
		"H1": "Date-like Text / CHAR", "H2": "2026-11-10", "I2": "",
	} {
		got, err := workbook.GetCellValue("SQL Results", cell)
		if err != nil || got != want {
			t.Errorf("%s = %q, err=%v; want %q", cell, got, err, want)
		}
	}
	for cell, want := range map[string]float64{
		"F2": float64(13*3600+14*60+15)/86_400 + 0.123456/86_400,
		"G2": float64(time.Date(2026, 11, 10, 13, 14, 15, 123456000, time.UTC).Sub(time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC))) / float64(24*time.Hour),
	} {
		raw, err := workbook.GetCellValue("SQL Results", cell, excelize.Options{RawCellValue: true})
		actual, parseErr := strconv.ParseFloat(raw, 64)
		if err != nil || parseErr != nil || math.Abs(actual-want) > 1e-11 {
			t.Errorf("%s raw Excel serial = %q, err=%v parseErr=%v; want %.15g", cell, raw, err, parseErr, want)
		}
	}
	for _, cell := range []string{"A2", "B2", "D2", "H2"} {
		kind, err := workbook.GetCellType("SQL Results", cell)
		if err != nil || kind == excelize.CellTypeNumber {
			t.Errorf("%s type = %v, err=%v; want text", cell, kind, err)
		}
	}
	for _, cell := range []string{"C2", "E2", "F2", "G2"} {
		kind, err := workbook.GetCellType("SQL Results", cell)
		if err != nil || (kind != excelize.CellTypeNumber && kind != excelize.CellTypeUnset) {
			t.Errorf("%s type = %v, err=%v; want number/date", cell, kind, err)
		}
	}
	style, err := workbook.GetCellStyle("SQL Results", "A1")
	if err != nil || style == 0 {
		t.Errorf("header style = %d, err=%v; want styled heading", style, err)
	}
	width, err := workbook.GetColWidth("SQL Results", "A")
	if err != nil || width < 10 {
		t.Errorf("column A width = %v, err=%v; want sensible width", width, err)
	}
}

func TestBuildXLSXEmptyResultHasHeader(t *testing.T) {
	data, err := buildXLSXWithSettings([]ColumnInfo{{Name: "No Rows", TypeName: "VARCHAR"}}, nil, testXLSXSettings)
	if err != nil {
		t.Fatal(err)
	}
	assertValidXLSXPackage(t, data)
	workbook, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer workbook.Close()
	got, err := workbook.GetCellValue("SQL Results", "A1")
	if err != nil || got != "No Rows" {
		t.Fatalf("header = %q, err=%v", got, err)
	}
	if got, err := workbook.GetSheetDimension("SQL Results"); err != nil || got != "A1:A1" {
		t.Errorf("worksheet dimension = %q, err=%v; want A1:A1", got, err)
	}
}

func TestBuildXLSXUsesStreamWriterForLargeResults(t *testing.T) {
	rows := make([][]any, xlsxStreamAtRows)
	for index := range rows {
		rows[index] = []any{index + 1, "row"}
	}
	data, err := buildXLSXWithSettings([]ColumnInfo{{Name: "N", Type: 4, TypeName: "INTEGER"}, {Name: "Text", TypeName: "VARCHAR"}}, rows, testXLSXSettings)
	if err != nil {
		t.Fatal(err)
	}
	assertValidXLSXPackage(t, data)
	workbook, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer workbook.Close()
	got, err := workbook.GetCellValue("SQL Results", "A10001")
	if err != nil || got != "10000" {
		t.Fatalf("last streamed row = %q, err=%v", got, err)
	}
	if got, err := workbook.GetSheetDimension("SQL Results"); err != nil || got != "A1:B10001" {
		t.Errorf("worksheet dimension = %q, err=%v; want A1:B10001", got, err)
	}
}

func TestXLSXFormatStylePresets(t *testing.T) {
	if style := xlsxDateCellStyle(""); style.NumFmt != 14 || style.CustomNumFmt != nil {
		t.Errorf("default date style = %+v; want locale built-in format 14", style)
	}
	if style := xlsxTimeCellStyle(""); style.NumFmt != 21 || style.CustomNumFmt != nil {
		t.Errorf("default time style = %+v; want locale built-in format 21", style)
	}
	if got, want := *xlsxTimestampCellStyle("locale").CustomNumFmt, localeTimestampNumberFormat(systemLocaleTag()); got != want {
		t.Errorf("locale timestamp style = %q; want %q", got, want)
	}
	if got := localeTimestampNumberFormat("en_US"); got != "m/d/yy h:mm:ss AM/PM" {
		t.Errorf("U.S. locale timestamp format = %q", got)
	}
	if got := localeTimestampNumberFormat("en_GB"); got != "dd/mm/yyyy hh:mm:ss" {
		t.Errorf("day-first locale timestamp format = %q", got)
	}
	if got := localeTimestampNumberFormat("ja_JP"); got != "yyyy/m/d hh:mm:ss" {
		t.Errorf("year-first locale timestamp format = %q", got)
	}
	if got := localeTimestampNumberFormat(""); got != "yyyy-mm-dd hh:mm:ss" {
		t.Errorf("unknown-locale timestamp format = %q", got)
	}
	for _, test := range []struct {
		name string
		got  *string
		want string
	}{
		{"date ISO", xlsxDateCellStyle("iso").CustomNumFmt, "yyyy-mm-dd"},
		{"date US", xlsxDateCellStyle("us").CustomNumFmt, "mm/dd/yyyy"},
		{"date EU", xlsxDateCellStyle("eu").CustomNumFmt, "dd/mm/yyyy"},
		{"IBM *MDY", xlsxDateCellStyle("mdy").CustomNumFmt, "mm/dd/yy"},
		{"IBM *MDYY", xlsxDateCellStyle("mdyy").CustomNumFmt, "mm/dd/yyyy"},
		{"IBM *DMY", xlsxDateCellStyle("dmy").CustomNumFmt, "dd/mm/yy"},
		{"IBM *DMYY", xlsxDateCellStyle("dmyy").CustomNumFmt, "dd/mm/yyyy"},
		{"IBM *YMD", xlsxDateCellStyle("ymd").CustomNumFmt, "yy/mm/dd"},
		{"IBM *YYMD", xlsxDateCellStyle("yymd").CustomNumFmt, "yyyy/mm/dd"},
		{"time 24h", xlsxTimeCellStyle("24h").CustomNumFmt, "hh:mm:ss"},
		{"time 12h", xlsxTimeCellStyle("12h").CustomNumFmt, "h:mm:ss AM/PM"},
		{"IBM *ISO", xlsxTimeCellStyle("iso").CustomNumFmt, `hh"."mm"."ss`},
		{"IBM *ISO12", xlsxTimeCellStyle("iso12").CustomNumFmt, `hh"."mm"."ss AM/PM`},
		{"timestamp ISO", xlsxTimestampCellStyle("iso").CustomNumFmt, `yyyy-mm-dd"T"hh:mm:ss.000`},
		{"timestamp US", xlsxTimestampCellStyle("us").CustomNumFmt, "mm/dd/yyyy h:mm:ss.000 AM/PM"},
		{"timestamp EU", xlsxTimestampCellStyle("eu").CustomNumFmt, "dd/mm/yyyy hh:mm:ss.000"},
		{"IBM i timestamp", xlsxTimestampCellStyle("ibmi").CustomNumFmt, "yyyy-mm-dd hh:mm:ss"},
		{"IBM i dotted timestamp", xlsxTimestampCellStyle("ibmiDot").CustomNumFmt, `yyyy-mm-dd hh"."mm"."ss`},
	} {
		if test.got == nil || *test.got != test.want {
			t.Errorf("%s format = %v; want %q", test.name, test.got, test.want)
		}
	}
}

func assertValidXLSXPackage(t *testing.T, data []byte) {
	t.Helper()
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("open XLSX ZIP package: %v", err)
	}
	parts := make(map[string]bool, len(archive.File))
	sharedStringRefs := 0
	sharedStringCount := -1
	for _, file := range archive.File {
		parts[file.Name] = true
		reader, err := file.Open()
		if err != nil {
			t.Fatalf("open ZIP part %s: %v", file.Name, err)
		}
		contents, readErr := io.ReadAll(reader)
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil {
			t.Fatalf("read ZIP part %s: read=%v close=%v", file.Name, readErr, closeErr)
		}
		if strings.HasSuffix(file.Name, ".xml") || strings.HasSuffix(file.Name, ".rels") {
			decoder := xml.NewDecoder(bytes.NewReader(contents))
			for {
				_, err := decoder.Token()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatalf("parse XML part %s: %v", file.Name, err)
				}
			}
		}
		if strings.HasPrefix(file.Name, "xl/worksheets/") || file.Name == "xl/sharedStrings.xml" {
			namespaceCount := bytes.Count(contents, []byte(`xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`))
			if namespaceCount != 1 {
				t.Errorf("%s has %d spreadsheet namespace declarations; want 1", file.Name, namespaceCount)
			}
		}
		if file.Name == "xl/styles.xml" {
			if bytes.Contains(contents, []byte(`formatCode="hh:mm:ss.000000"`)) || bytes.Contains(contents, []byte(`formatCode="yyyy-mm-dd hh:mm:ss.000000"`)) {
				t.Error("styles contain unsupported six-digit fractional-second formats")
			}
		}
		if strings.HasPrefix(file.Name, "xl/worksheets/") && strings.HasSuffix(file.Name, ".xml") {
			count, err := countSharedStringRefs(contents)
			if err != nil {
				t.Fatalf("count shared strings in %s: %v", file.Name, err)
			}
			sharedStringRefs += count
		}
		if file.Name == "xl/sharedStrings.xml" {
			decoder := xml.NewDecoder(bytes.NewReader(contents))
			for {
				token, err := decoder.Token()
				if err != nil {
					if err != io.EOF {
						t.Fatalf("read shared string table: %v", err)
					}
					break
				}
				root, ok := token.(xml.StartElement)
				if !ok || root.Name.Local != "sst" {
					continue
				}
				for _, attr := range root.Attr {
					if attr.Name.Local == "count" {
						sharedStringCount, err = strconv.Atoi(attr.Value)
						if err != nil {
							t.Fatalf("invalid shared string count: %v", err)
						}
					}
				}
				break
			}
		}
	}
	if !(sharedStringCount == -1 && sharedStringRefs == 0) && sharedStringCount != sharedStringRefs {
		t.Errorf("shared string count = %d, worksheet references = %d", sharedStringCount, sharedStringRefs)
	}
	for _, required := range []string{"[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/styles.xml"} {
		if !parts[required] {
			t.Errorf("XLSX package is missing %s", required)
		}
	}
}

func TestXLSXDimensionLimitsAndHelpers(t *testing.T) {
	if err := validateXLSXDimensions(xlsxMaxColumns+1, 0); err == nil || !strings.Contains(err.Error(), "columns") {
		t.Fatalf("column limit error = %v", err)
	}
	if err := validateXLSXDimensions(1, xlsxMaxRows); err == nil || !strings.Contains(err.Error(), "rows") {
		t.Fatalf("row limit error = %v", err)
	}
	if got := ensureXLSXExtension("report.csv"); got != "report.xlsx" {
		t.Fatalf("extension = %q", got)
	}
	if _, ok := xlsxNumericValue("1.230", ColumnInfo{TypeName: "DECIMAL", Scale: 3}); !ok {
		t.Fatal("expected exact-scale decimal to be numeric")
	}
}
