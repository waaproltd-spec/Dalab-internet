package com.dalab.internet.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneValidatorTest {

    @Test
    fun `exactly 9 digits with a known prefix is valid with no company selected`() {
        assertTrue(isValidMobileNumber("617080008"))
    }

    @Test
    fun `8 digits is rejected`() {
        val result = validateMobileNumber("61708000")
        assertFalse(result.valid)
        assertEquals("Invalid phone number. Enter exactly 9 digits.", result.error)
    }

    @Test
    fun `10 digits (leading 0 plus 9 digits) is rejected`() {
        val result = validateMobileNumber("0617080008")
        assertFalse(result.valid)
        assertEquals("Invalid phone number. Enter exactly 9 digits.", result.error)
    }

    @Test
    fun `a number starting with 0 but otherwise 9 digits long is still rejected`() {
        assertFalse(validateMobileNumber("012345678").valid)
    }

    @Test
    fun `letters are rejected`() {
        assertFalse(isValidMobileNumber("61708000a"))
        assertFalse(isValidMobileNumber("abcdefghi"))
    }

    @Test
    fun `a 252 country code prefix is rejected, not silently normalized away`() {
        val result1 = validateMobileNumber("+252617080008")
        assertFalse(result1.valid)
        assertEquals("Enter your number as 9 digits without the 252 country code, e.g. 617080008 — not 252617080008.", result1.error)
        val result2 = validateMobileNumber("252617080008")
        assertFalse(result2.valid)
        assertEquals("Enter your number as 9 digits without the 252 country code, e.g. 617080008 — not 252617080008.", result2.error)
        // Every supported prefix, all rejected the same way when 252-prefixed.
        assertFalse(isValidMobileNumber("252617080008"))
        assertFalse(isValidMobileNumber("252777080008"))
        assertFalse(isValidMobileNumber("252687080008"))
        assertFalse(isValidMobileNumber("252627080008"))
        assertFalse(isValidMobileNumber("252717080008"))
    }

    @Test
    fun `all four provider prefixes are valid as plain 9-digit local numbers`() {
        assertTrue(isValidMobileNumber("617080008")) // Hormuud
        assertTrue(isValidMobileNumber("777080008")) // Hormuud
        assertTrue(isValidMobileNumber("687080008")) // Somnet
        assertTrue(isValidMobileNumber("627080008")) // Somtel
        assertTrue(isValidMobileNumber("717080008")) // Amtel
    }

    @Test
    fun `empty or null is rejected, not thrown`() {
        assertFalse(isValidMobileNumber(""))
        assertFalse(isValidMobileNumber(null))
    }

    @Test
    fun `companyForPrefix identifies the right carrier`() {
        assertEquals("evc_plus", companyForPrefix("617080008")?.key)
        assertEquals("evc_plus", companyForPrefix("770080008")?.key)
        assertEquals("jeeb", companyForPrefix("687080008")?.key)
        assertEquals("edahab", companyForPrefix("627080008")?.key)
        assertEquals("amtel_pay", companyForPrefix("717080008")?.key)
        assertNull(companyForPrefix("997080008"))
    }

    @Test
    fun `EVC Plus accepts both 61 and 77 prefixes, rejects others`() {
        assertTrue(validateMobileNumber("617080008", "evc_plus").valid)
        assertTrue(validateMobileNumber("770080008", "evc_plus").valid)
        val rejected = validateMobileNumber("687080008", "evc_plus")
        assertFalse(rejected.valid)
        assertEquals("Invalid number. EVC Plus numbers must start with 61 or 77.", rejected.error)
    }

    @Test
    fun `Somnet (jeeb) only accepts the 68 prefix`() {
        assertTrue(validateMobileNumber("687080008", "jeeb").valid)
        val rejected = validateMobileNumber("617080008", "jeeb")
        assertFalse(rejected.valid)
        assertEquals("Invalid number. Somnet numbers must start with 68.", rejected.error)
    }

    @Test
    fun `Somtel (edahab) only accepts the 62 prefix`() {
        assertTrue(validateMobileNumber("627080008", "edahab").valid)
        assertFalse(validateMobileNumber("617080008", "edahab").valid)
    }

    @Test
    fun `Amtel (amtel_pay) only accepts the 71 prefix`() {
        assertTrue(validateMobileNumber("717080008", "amtel_pay").valid)
        assertFalse(validateMobileNumber("627080008", "amtel_pay").valid)
    }

    @Test
    fun `a number with a prefix belonging to no known carrier at all is rejected even with no company selected`() {
        val result = validateMobileNumber("997080008")
        assertFalse(result.valid)
        assertEquals("Invalid phone number. This prefix is not recognized for any supported carrier.", result.error)
    }

    @Test
    fun `normalizeMobileDigits strips punctuation and spaces`() {
        assertEquals("617080008", normalizeMobileDigits("61-708-0008"))
        assertEquals("617080008", normalizeMobileDigits("61 708 0008"))
    }

    @Test
    fun `normalizeMobileDigits does not strip a leading 0 -- that's a real error, not noise`() {
        assertEquals("0617080008", normalizeMobileDigits("0617080008"))
    }

    @Test
    fun `companyKeyFromLabel recognizes company names and admin-chosen slugs by keyword`() {
        assertEquals("evc_plus", companyKeyFromLabel("Hormuud"))
        assertEquals("evc_plus", companyKeyFromLabel("hormuud"))
        assertEquals("evc_plus", companyKeyFromLabel("EVC Plus"))
        assertEquals("edahab", companyKeyFromLabel("Somtel"))
        assertEquals("edahab", companyKeyFromLabel("eDahab"))
        assertEquals("jeeb", companyKeyFromLabel("Somnet"))
        assertEquals("jeeb", companyKeyFromLabel("JEEB"))
        assertEquals("amtel_pay", companyKeyFromLabel("Amtel"))
        assertNull(companyKeyFromLabel("Golis"))
        assertNull(companyKeyFromLabel(null))
    }
}
