// Tests for the SQL type mapping ported from cozzi-cl-prompter sqlResultPanel.ts.
import { describe, expect, it } from "vitest";
import {
    columnHeaderLines,
    columnKind,
    formatCellText,
    formatTooltipType,
    isExactNumericColumn,
    isNumericColumn,
    shouldRightAlign,
    sortValue,
} from "../src/sqltypes";
import type { ColumnInfo } from "../src/types";

function col(partial: Partial<ColumnInfo>): ColumnInfo {
    return {
        name: "COL", label: "", type: 12, typeName: "VARCHAR", precision: 0,
        scale: 0, displaySize: 0, nullable: true, autoIncrement: false,
        schemaName: "", tableName: "", ...partial,
    };
}

describe("columnKind", () => {
    it("maps DATE/TIME/TIMESTAMP by typeName", () => {
        expect(columnKind(col({ typeName: "DATE" }))).toBe("date");
        expect(columnKind(col({ typeName: "TIME" }))).toBe("time");
        expect(columnKind(col({ typeName: "TIMESTAMP" }))).toBe("timestamp");
    });
    it("maps numeric by typeName base and JDBC code", () => {
        expect(columnKind(col({ typeName: "DECIMAL" }))).toBe("number");
        expect(columnKind(col({ typeName: "DOUBLE PRECISION" }))).toBe("number");
        expect(columnKind(col({ type: 3, typeName: "" }))).toBe("number"); // DECIMAL code
    });
    it("falls back to text", () => {
        expect(columnKind(col({ typeName: "VARCHAR" }))).toBe("text");
        expect(columnKind(col({ typeName: "CLOB" }))).toBe("text");
    });
});

describe("isNumeric / isExactNumeric", () => {
    it("NUMERIC/DECIMAL are exact, DOUBLE/FLOAT are not", () => {
        expect(isExactNumericColumn(col({ typeName: "NUMERIC" }))).toBe(true);
        expect(isExactNumericColumn(col({ typeName: "DECFLOAT" }))).toBe(false);
        expect(isNumericColumn(col({ typeName: "FLOAT" }))).toBe(true);
    });
});

describe("formatTooltipType", () => {
    it("renders Zoned/Dec with precision and scale", () => {
        expect(formatTooltipType(col({ typeName: "NUMERIC", precision: 7, scale: 2 }))).toBe("Zoned(7, 2)");
        expect(formatTooltipType(col({ typeName: "DECIMAL", precision: 9, scale: 0 }))).toBe("Dec(9, 0)");
    });
    it("renders char length", () => {
        expect(formatTooltipType(col({ typeName: "VARCHAR", displaySize: 50 }))).toBe("VARCHAR(50)");
    });
    it("integer types render bare", () => {
        expect(formatTooltipType(col({ typeName: "BIGINT", precision: 19 }))).toBe("BIGINT");
    });
});

describe("columnHeaderLines", () => {
    it("stacks up to 3 words, compresses COLHDG padding", () => {
        expect(columnHeaderLines("Cust                Name")).toEqual(["Cust", "Name"]);
        expect(columnHeaderLines("One Two Three Four")).toEqual(["One", "Two", "Three"]);
        expect(columnHeaderLines("")).toEqual([""]);
    });
});

describe("formatCellText", () => {
    it("pads exact numeric text to scale", () => {
        const c = col({ typeName: "DECIMAL", scale: 2 });
        expect(formatCellText("123", c).text).toBe("123.00");
        expect(formatCellText("1.5", c).text).toBe("1.50");
    });
    it("preserves leading CHAR spaces while removing only fixed-width right padding", () => {
        expect(formatCellText("  source line  ", col({ type: 1, typeName: "CHAR" })).text).toBe("  source line");
        expect(formatCellText("  value  ", col({ type: 12, typeName: "VARCHAR" })).text).toBe("  value  ");
    });
    it("NULL handling", () => {
        expect(formatCellText(null, col({})).isNull).toBe(true);
    });
});

describe("sortValue", () => {
    it("bigint-safe: huge integers sort as text", () => {
        const c = col({ typeName: "BIGINT" });
        expect(sortValue("900719925474099312345", c).kind).toBe("text");
        expect(sortValue("42", c).kind).toBe("number");
    });
    it("dates sort numerically by epoch", () => {
        const c = col({ typeName: "DATE" });
        const a = sortValue("2020-01-01", c);
        const b = sortValue("2021-01-01", c);
        expect(a.kind).toBe("number");
        expect((a.v as number) < (b.v as number)).toBe(true);
    });
});

describe("shouldRightAlign", () => {
    it("numbers and dates right-align, text does not", () => {
        expect(shouldRightAlign(col({ typeName: "DECIMAL" }))).toBe(true);
        expect(shouldRightAlign(col({ typeName: "DATE" }))).toBe(true);
        expect(shouldRightAlign(col({ typeName: "VARCHAR" }))).toBe(false);
    });
});
