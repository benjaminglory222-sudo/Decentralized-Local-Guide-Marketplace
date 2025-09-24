(define-constant ERR_NOT_AUTHORIZED u100)
(define-constant ERR_INVALID_BOOKING u101)
(define-constant ERR_ALREADY_DEPOSITED u102)
(define-constant ERR_NO_DEPOSIT u103)
(define-constant ERR_DISPUTE_ACTIVE u104)
(define-constant ERR_INVALID_AMOUNT u105)
(define-constant ERR_INVALID_STATUS u106)
(define-constant ERR_FEE_NOT_SET u107)
(define-constant ERR_INVALID_FEE u108)
(define-constant ERR_NOT_ADMIN u109)

(define-data-var admin principal tx-sender)
(define-data-var platform-fee uint u100)
(define-map Escrows
  { booking-id: uint }
  {
    traveler: principal,
    guide: principal,
    amount: uint,
    status: (string-ascii 20),
    dispute-active: bool,
    deposit-time: uint,
    fee-amount: uint
  }
)
(define-map BookingContracts { contract-id: uint } principal)

(define-read-only (get-escrow-details (booking-id uint))
  (map-get? Escrows { booking-id: booking-id })
)

(define-read-only (get-platform-fee)
  (ok (var-get platform-fee))
)

(define-read-only (get-booking-contract (contract-id uint))
  (map-get? BookingContracts { contract-id: contract-id })
)

(define-private (validate-amount (amount uint))
  (if (> amount u0)
      (ok true)
      (err ERR_INVALID_AMOUNT))
)

(define-private (validate-status (status (string-ascii 20)))
  (if (or (is-eq status "deposited") (is-eq status "released") (is-eq status "refunded"))
      (ok true)
      (err ERR_INVALID_STATUS))
)

(define-private (validate-booking (booking-id uint))
  (let ((booking-contract (unwrap! (get-booking-contract u1) (err ERR_NOT_AUTHORIZED))))
    (contract-call? booking-contract get-booking-details booking-id)))

(define-public (set-platform-fee (fee uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR_NOT_ADMIN))
    (asserts! (> fee u0) (err ERR_INVALID_FEE))
    (var-set platform-fee fee)
    (ok true)
  )
)

(define-public (set-booking-contract (contract-id uint) (contract-principal principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR_NOT_ADMIN))
    (map-set BookingContracts { contract-id: contract-id } contract-principal)
    (ok true)
  )
)

(define-public (deposit-payment (booking-id uint) (amount uint))
  (let ((booking-details (try! (validate-booking booking-id))))
    (asserts! (is-eq (get status booking-details) "confirmed") (err ERR_INVALID_BOOKING))
    (asserts! (is-none (map-get? Escrows { booking-id: booking-id })) (err ERR_ALREADY_DEPOSITED))
    (try! (validate-amount amount))
    (let ((fee (var-get platform-fee)))
      (try! (stx-transfer? fee tx-sender (var-get admin)))
      (try! (stx-transfer? (- amount fee) tx-sender (as-contract tx-sender)))
      (map-set Escrows
        { booking-id: booking-id }
        {
          traveler: tx-sender,
          guide: (get guide booking-details),
          amount: (- amount fee),
          status: "deposited",
          dispute-active: false,
          deposit-time: block-height,
          fee-amount: fee
        }
      )
      (print { event: "payment-deposited", booking-id: booking-id, amount: amount })
      (ok true)
    )
  )
)

(define-public (release-payment (booking-id uint))
  (let ((escrow (unwrap! (map-get? Escrows { booking-id: booking-id }) (err ERR_NO_DEPOSIT))))
    (asserts! (is-eq tx-sender (get traveler escrow)) (err ERR_NOT_AUTHORIZED))
    (asserts! (is-eq (get status escrow) "deposited") (err ERR_INVALID_STATUS))
    (asserts! (not (get dispute-active escrow)) (err ERR_DISPUTE_ACTIVE))
    (map-set Escrows
      { booking-id: booking-id }
      (merge escrow { status: "released" })
    )
    (try! (as-contract (stx-transfer? (get amount escrow) tx-sender (get guide escrow))))
    (print { event: "payment-released", booking-id: booking-id })
    (ok true)
  )
)

(define-public (refund-payment (booking-id uint))
  (let ((escrow (unwrap! (map-get? Escrows { booking-id: booking-id }) (err ERR_NO_DEPOSIT))))
    (asserts! (or (is-eq tx-sender (get traveler escrow)) (is-eq tx-sender (var-get admin))) (err ERR_NOT_AUTHORIZED))
    (asserts! (is-eq (get status escrow) "deposited") (err ERR_INVALID_STATUS))
    (asserts! (not (get dispute-active escrow)) (err ERR_DISPUTE_ACTIVE))
    (map-set Escrows
      { booking-id: booking-id }
      (merge escrow { status: "refunded" })
    )
    (try! (as-contract (stx-transfer? (get amount escrow) tx-sender (get traveler escrow))))
    (print { event: "payment-refunded", booking-id: booking-id })
    (ok true)
  )
)

(define-public (flag-dispute (booking-id uint))
  (let ((escrow (unwrap! (map-get? Escrows { booking-id: booking-id }) (err ERR_NO_DEPOSIT))))
    (asserts! (is-eq tx-sender (get traveler escrow)) (err ERR_NOT_AUTHORIZED))
    (asserts! (is-eq (get status escrow) "deposited") (err ERR_INVALID_STATUS))
    (asserts! (not (get dispute-active escrow)) (err ERR_DISPUTE_ACTIVE))
    (map-set Escrows
      { booking-id: booking-id }
      (merge escrow { dispute-active: true })
    )
    (print { event: "dispute-flagged", booking-id: booking-id })
    (ok true)
  )
)

(define-public (resolve-dispute (booking-id uint) (release-to-guide bool))
  (let ((escrow (unwrap! (map-get? Escrows { booking-id: booking-id }) (err ERR_NO_DEPOSIT))))
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR_NOT_AUTHORIZED))
    (asserts! (get dispute-active escrow) (err ERR_DISPUTE_ACTIVE))
    (asserts! (is-eq (get status escrow) "deposited") (err ERR_INVALID_STATUS))
    (map-set Escrows
      { booking-id: booking-id }
      (merge escrow { status: (if release-to-guide "released" "refunded"), dispute-active: false })
    )
    (try! (as-contract
      (stx-transfer?
        (get amount escrow)
        tx-sender
        (if release-to-guide (get guide escrow) (get traveler escrow))
      )
    ))
    (print { event: "dispute-resolved", booking-id: booking-id, release-to-guide: release-to-guide })
    (ok true)
  )
)